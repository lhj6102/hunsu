import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import {
  createDeviceAuthorizationRequest,
  createPkceAuthorizationRequest,
  exchangeAuthorizationCode,
  FileCredentialStore,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  startLocalDevAuthServer,
  WindowsDpapiCredentialStore
} from "../apps/bridge-desktop/src/auth.ts";
import { main, normalizeBridgeAppArgv } from "../apps/bridge-desktop/src/main.ts";
import { protocolRegistrationPlan } from "../apps/bridge-desktop/src/native-shell.ts";
import { currentNodeRuntimeStatus } from "../apps/bridge-desktop/src/commands/diagnosticsCommands.ts";
import { currentBridgeCommandInvocation } from "../apps/bridge-desktop/src/processes/backgroundSpawn.ts";
import { evaluateRelayCommand, FileRelayRegistry, forwardRelayCommand, forwardRelayCommandStream, LocalDevRelayService, RelayOutboundClient, relayHttpRequestForCommand, scopesForRelayCommand, type ProjectGrant, type RelayCommand, type RelayHttpRequest } from "../apps/bridge-desktop/src/relay.ts";
import { BridgeSidecarSupervisor } from "../apps/bridge-desktop/src/sidecar-supervisor.ts";
import { createStudioRoadmap, createStudioServer, createStudioState, listManagedRoadmapRegistry, setRoadmapLifecycle } from "../apps/bridge/src/index.ts";

test("Bridge App parses browser deep links into command arguments", () => {
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open"]), ["ui-intent", "provider"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://pair?next=/studio/roadmaps/roadmap_123"]), [
    "pair",
    "--next",
    "/studio/roadmaps/roadmap_123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://pair?code=abc123&state=state123"]), [
    "auth-callback",
    "--code",
    "abc123",
    "--state",
    "state123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-project?path=/tmp/example"]), ["open-project", "/tmp/example"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-roadmap?roadmapId=roadmap_123"]), [
    "open-roadmap",
    "roadmap_123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-workspace?workspaceId=roadmap_123"]), [
    "open-roadmap",
    "roadmap_123"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://provider"]), ["ui-intent", "provider"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://provider/codex"]), ["ui-intent", "provider", "codex"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://codex"]), ["ui-intent", "provider", "codex"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://workspaces"]), ["ui-intent", "workspaces"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://add-workspace"]), ["ui-intent", "workspaces", "add-workspace"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://add-workspace?path=/tmp/example"]), ["roadmaps", "add", "/tmp/example"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://connection"]), ["ui-intent", "connection"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://connection/remote"]), ["ui-intent", "connection", "remote"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://add-roadmap"]), ["ui-intent", "workspaces", "add-workspace"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://add-roadmap?path=/tmp/example"]), ["roadmaps", "add", "/tmp/example"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://roadmaps"]), ["ui-intent", "workspaces"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://prerequisites"]), ["ui-intent", "provider"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://prerequisites/codex"]), ["ui-intent", "provider", "codex"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://diagnostics"]), ["ui-intent", "diagnostics"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://activate-roadmap?roadmapId=roadmap_123"]), ["activate-roadmap", "roadmap_123"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://activate-workspace?workspaceId=roadmap_123"]), ["activate-roadmap", "roadmap_123"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://remote-disable"]), ["remote", "disable"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://sign-in"]), ["login", "--gui"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://sign-out"]), ["logout"]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://delete-everything"]), [
    "protocol-error",
    "Unsupported hunsu:// command: delete-everything"
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://prerequisites/other"]), [
    "protocol-error",
    "Unsupported hunsu://prerequisites path."
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://diagnostics/other"]), [
    "protocol-error",
    "Unsupported hunsu://diagnostics path."
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://open-roadmap"]), [
    "protocol-error",
    "hunsu://open-roadmap requires roadmapId."
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://activate-roadmap"]), [
    "protocol-error",
    "hunsu://activate-roadmap requires roadmapId."
  ]);
  assert.deepEqual(normalizeBridgeAppArgv(["hunsu://activate-workspace"]), [
    "protocol-error",
    "hunsu://activate-workspace requires workspaceId."
  ]);
});

test("Bridge App rejects unsupported browser deep links", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-deeplink-reject-test-"));
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousError = console.error;
  const errors: string[] = [];
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = join(root, "bridge-app.log");
  console.error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };
  try {
    assert.equal(await main(["hunsu://delete-everything"]), 1);
    assert.equal(errors.some(line => line.includes("Unsupported hunsu:// command")), true);
  } finally {
    console.error = previousError;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App version and Node runtime checks never start the packaged sidecar", async () => {
  const output: string[] = [];
  const previousLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };
  try {
    assert.equal(await main(["--version"]), 0);
  } finally {
    console.log = previousLog;
  }

  assert.deepEqual(output, ["Hunsu Bridge 0.1.0"]);
  assert.deepEqual(currentNodeRuntimeStatus("C:\\Hunsu\\hunsu-bridge.exe", "v22.22.0"), {
    installed: true,
    binaryPath: "C:\\Hunsu\\hunsu-bridge.exe",
    version: "v22.22.0"
  });
});

test("Bridge App Roadmap deep links record UI intents for native focus flows", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-deeplink-intent-test-"));
  const statePath = join(root, "state.json");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const logPath = join(root, "bridge-app.log");
  const previousEnv = snapshotEnv([
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH"
  ]);
  const previousLog = console.log;
  console.log = () => undefined;
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  try {
    assert.equal(await main(["hunsu://add-roadmap"]), 0);
    const addRoadmapState = JSON.parse(readFileSync(statePath, "utf8")) as { uiIntent?: { tab?: string; action?: string } };
    assert.deepEqual({ tab: addRoadmapState.uiIntent?.tab, action: addRoadmapState.uiIntent?.action }, { tab: "workspaces", action: "add-workspace" });

    assert.equal(await main(["hunsu://prerequisites/codex"]), 0);
    const codexState = JSON.parse(readFileSync(statePath, "utf8")) as { uiIntent?: { tab?: string; focus?: string } };
    assert.deepEqual({ tab: codexState.uiIntent?.tab, focus: codexState.uiIntent?.focus }, { tab: "provider", focus: "codex" });

    assert.equal(await main(["hunsu://connection/remote"]), 0);
    const remoteState = JSON.parse(readFileSync(statePath, "utf8")) as { uiIntent?: { tab?: string; focus?: string } };
    assert.deepEqual({ tab: remoteState.uiIntent?.tab, focus: remoteState.uiIntent?.focus }, { tab: "connection", focus: "remote" });

    assert.equal(await main(["hunsu://diagnostics"]), 0);
    const diagnosticsState = JSON.parse(readFileSync(statePath, "utf8")) as { uiIntent?: { tab?: string } };
    assert.equal(diagnosticsState.uiIntent?.tab, "diagnostics");

    assert.equal(await main(["hunsu://activate-roadmap?roadmapId=unknown_roadmap"]), 0);
    const activateState = JSON.parse(readFileSync(statePath, "utf8")) as { uiIntent?: { tab?: string } };
    assert.equal(activateState.uiIntent?.tab, "workspaces");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Tauri tray routes focus, refreshes summaries, and uses persisted quit behavior", () => {
  const source = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/src/main.rs"), "utf8");
  assert.match(source, /fn handle_protocol_url_and_show/);
  assert.match(source, /"provider" => handle_protocol_url_and_show\(app, "hunsu:\/\/provider"\)/);
  assert.match(source, /"add_workspace" => handle_protocol_url_and_show\(app, "hunsu:\/\/add-workspace"\)/);
  assert.match(source, /"workspaces" => handle_protocol_url_and_show\(app, "hunsu:\/\/workspaces"\)/);
  assert.match(source, /"connection" => handle_protocol_url_and_show\(app, "hunsu:\/\/connection"\)/);
  assert.match(source, /"diagnostics" => handle_protocol_url_and_show\(app, "hunsu:\/\/diagnostics"\)/);
  assert.match(source, /app\.deep_link\(\)\.on_open_url/);
  assert.match(source, /app\.deep_link\(\)\.get_current\(\)/);
  assert.match(source, /#\[cfg\(target_os = "linux"\)\][\s\S]*app\.deep_link\(\)\.register_all\(\)/);
  assert.match(source, /fn start_bridge_tray_refresh/);
  assert.match(source, /fn refresh_bridge_tray_menu/);
  assert.match(source, /tray\.set_menu\(Some\(menu\)\)/);
  assert.match(source, /quit_background_preference/);
  assert.match(source, /snapshot\["status"\]\["quitBehavior"\]/);
  assert.doesNotMatch(source, /HUNSU_BRIDGE_QUIT_BACKGROUND/);
});

test("Bridge App Codex device login command returns verification details for UI display", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-device-ui-test-"));
  const fakeCodex = join(root, "codex");
  const statePath = join(root, "state.json");
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const readline = require('node:readline');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 1.2.3'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === '--device-auth') {",
    "  console.log('Open https://auth.openai.com/activate?user_code=HUNSU-5678');",
    "  console.log('Code: HUNSU-5678');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'app-server') {",
    "  const rl = readline.createInterface({ input: process.stdin });",
    "  rl.on('line', line => {",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'test' } }));",
    "    else if (msg.method === 'account/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authMethod: 'chatgpt', email: 'dev@example.test' } }));",
    "    else if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { label: 'Available', remaining: 'available' } }));",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  const previousEnv = snapshotEnv(["HUNSU_CODEX_BINARY_PATH", "HUNSU_BRIDGE_APP_STATE_PATH", "PATH"]);
  const previousLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    process.env.HUNSU_CODEX_BINARY_PATH = fakeCodex;
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.PATH = "";
    assert.equal(await main(["codex", "login", "--device", "--json"]), 0);
    const result = JSON.parse(logs.at(-1) ?? "{}") as {
      state?: string;
      verificationUriComplete?: string;
      userCode?: string;
      args?: string[];
    };
    assert.equal(result.state, "device_code");
    assert.equal(result.verificationUriComplete, "https://auth.openai.com/activate?user_code=HUNSU-5678");
    assert.equal(result.userCode, "HUNSU-5678");
    assert.deepEqual(result.args, ["login", "--device-auth"]);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { codexLogin?: { status?: string; userCode?: string } };
    assert.equal(state.codexLogin?.status, "device_code");
    assert.equal(state.codexLogin?.userCode, "HUNSU-5678");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex device login JSON preserves code details when later exit fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-device-code-then-fail-test-"));
  const fakeCodex = join(root, "codex");
  const statePath = join(root, "state.json");
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const readline = require('node:readline');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 1.2.3'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === '--device-auth') {",
    "  console.log('Open https://auth.openai.com/activate?user_code=HUNSU-FAIL');",
    "  console.log('Code: HUNSU-FAIL');",
    "  console.error('device auth failed after code');",
    "  process.exit(7);",
    "}",
    "if (args[0] === 'app-server') {",
    "  const rl = readline.createInterface({ input: process.stdin });",
    "  rl.on('line', line => {",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'test' } }));",
    "    else if (msg.method === 'account/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authMethod: 'chatgpt', email: 'dev@example.test' } }));",
    "    else if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { label: 'Available', remaining: 'available' } }));",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  const previousEnv = snapshotEnv(["HUNSU_CODEX_BINARY_PATH", "HUNSU_BRIDGE_APP_STATE_PATH", "PATH"]);
  const previousLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    process.env.HUNSU_CODEX_BINARY_PATH = fakeCodex;
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.PATH = "";
    assert.equal(await main(["codex", "login", "--device", "--json"]), 0);
    const result = JSON.parse(logs.at(-1) ?? "{}") as {
      state?: string;
      verificationUriComplete?: string;
      userCode?: string;
      error?: string;
      lastOutput?: string;
    };
    assert.equal(result.state, "failed");
    assert.equal(result.verificationUriComplete, "https://auth.openai.com/activate?user_code=HUNSU-FAIL");
    assert.equal(result.userCode, "HUNSU-FAIL");
    assert.match(result.error ?? "", /status 7/);
    assert.match(result.lastOutput ?? "", /device auth failed after code/);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { codexLogin?: { status?: string; userCode?: string } };
    assert.equal(state.codexLogin?.status, "failed");
    assert.equal(state.codexLogin?.userCode, "HUNSU-FAIL");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex device background login persists delayed failure after device code", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-device-background-fail-test-"));
  const fakeCodex = join(root, "codex");
  const statePath = join(root, "state.json");
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const readline = require('node:readline');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 1.2.3'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === '--device-auth') {",
    "  console.log('Open https://auth.openai.com/activate?user_code=HUNSU-LATE');",
    "  console.log('Code: HUNSU-LATE');",
    "  setTimeout(() => {",
    "    console.error('device auth failed after background delay');",
    "    process.exit(7);",
    "  }, 3400);",
    "  return;",
    "}",
    "if (args[0] === 'app-server') {",
    "  const rl = readline.createInterface({ input: process.stdin });",
    "  rl.on('line', line => {",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'test' } }));",
    "    else if (msg.method === 'account/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authMethod: 'chatgpt', email: 'dev@example.test' } }));",
    "    else if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { label: 'Available', remaining: 'available' } }));",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  const previousEnv = snapshotEnv(["HUNSU_CODEX_BINARY_PATH", "HUNSU_BRIDGE_APP_STATE_PATH", "PATH"]);
  const previousLog = console.log;
  console.log = () => {};
  try {
    process.env.HUNSU_CODEX_BINARY_PATH = fakeCodex;
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.PATH = "";
    assert.equal(await main(["codex", "login", "--device", "--background"]), 0);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      codexLogin?: {
        status?: string;
        verificationUri?: string;
        verificationUriComplete?: string;
        userCode?: string;
        error?: string;
        lastOutput?: string;
      };
    };
    assert.equal(state.codexLogin?.status, "failed");
    assert.equal(state.codexLogin?.verificationUri, "https://auth.openai.com/activate?user_code=HUNSU-LATE");
    assert.equal(state.codexLogin?.verificationUriComplete, "https://auth.openai.com/activate?user_code=HUNSU-LATE");
    assert.equal(state.codexLogin?.userCode, "HUNSU-LATE");
    assert.match(state.codexLogin?.error ?? "", /status 7/);
    assert.match(state.codexLogin?.error ?? "", /device auth failed after background delay/);
    assert.match(state.codexLogin?.lastOutput ?? "", /HUNSU-LATE/);
    assert.match(state.codexLogin?.lastOutput ?? "", /device auth failed after background delay/);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex ChatGPT login command records pending state and recheck clears authenticated state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-chatgpt-login-test-"));
  const fakeCodex = join(root, "codex");
  const statePath = join(root, "state.json");
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const readline = require('node:readline');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 1.2.3'); process.exit(0); }",
    "if (args[0] === 'login') { process.exit(0); }",
    "if (args[0] === 'app-server') {",
    "  const rl = readline.createInterface({ input: process.stdin });",
    "  rl.on('line', line => {",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'test' } }));",
    "    else if (msg.method === 'account/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authMethod: 'chatgpt', email: 'dev@example.test' } }));",
    "    else if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { label: 'Available', remaining: 'available' } }));",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  const previousEnv = snapshotEnv(["HUNSU_CODEX_BINARY_PATH", "HUNSU_BRIDGE_APP_STATE_PATH", "PATH"]);
  const previousLog = console.log;
  console.log = () => {};
  try {
    process.env.HUNSU_CODEX_BINARY_PATH = fakeCodex;
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.PATH = "";
    assert.equal(await main(["codex", "login"]), 0);
    const pendingState = JSON.parse(readFileSync(statePath, "utf8")) as { codexLogin?: { kind?: string; status?: string; lastOutput?: string } };
    assert.equal(pendingState.codexLogin?.kind, "chatgpt");
    assert.equal(pendingState.codexLogin?.status, "pending");
    assert.match(pendingState.codexLogin?.lastOutput ?? "", /Complete sign-in/);

    assert.equal(await main(["codex", "recheck"]), 0);
    const recheckedState = JSON.parse(readFileSync(statePath, "utf8")) as { codexLogin?: unknown };
    assert.equal(recheckedState.codexLogin, undefined);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex ChatGPT login command records failed state when Codex is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-chatgpt-login-fail-test-"));
  const statePath = join(root, "state.json");
  const previousEnv = snapshotEnv(["HUNSU_CODEX_BINARY_PATH", "HUNSU_BRIDGE_APP_STATE_PATH", "HUNSU_BRIDGE_APP_LOG_PATH", "PATH"]);
  const previousError = console.error;
  console.error = () => {};
  try {
    process.env.HUNSU_CODEX_BINARY_PATH = join(root, "missing-codex");
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.HUNSU_BRIDGE_APP_LOG_PATH = join(root, "bridge-app.log");
    process.env.PATH = "";
    assert.equal(await main(["codex", "login"]), 1);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { codexLogin?: { kind?: string; status?: string; error?: string } };
    assert.equal(state.codexLogin?.kind, "chatgpt");
    assert.equal(state.codexLogin?.status, "failed");
    assert.match(state.codexLogin?.error ?? "", /not found|missing|no such file/i);
  } finally {
    console.error = previousError;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex path command persists provider settings instead of legacy Codex state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-path-settings-test-"));
  const fakeCodex = join(root, "codex");
  const codexHome = join(root, "codex-home");
  const statePath = join(root, "state.json");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const readline = require('node:readline');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 1.2.3'); process.exit(0); }",
    "if (args[0] === 'app-server') {",
    "  const rl = readline.createInterface({ input: process.stdin });",
    "  rl.on('line', line => {",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'test' } }));",
    "    else if (msg.method === 'account/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authMethod: 'chatgpt', email: 'dev@example.test' } }));",
    "    else if (msg.method === 'account/rateLimits/read') console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { label: 'Available', remaining: 'available' } }));",
    "  });",
    "  return;",
    "}",
    "process.exit(2);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  const previousEnv = snapshotEnv(["HUNSU_BRIDGE_APP_STATE_PATH", "PATH"]);
  const previousLog = console.log;
  console.log = () => {};
  try {
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.PATH = "";
    assert.equal(await main(["codex", "path", "set", fakeCodex]), 0);
    assert.equal(await main(["codex", "home", "set", codexHome]), 0);
    const fields = JSON.stringify([
      { key: "binaryPath", value: fakeCodex, isSet: true, isSecret: false },
      { key: "codexHome", value: codexHome, isSet: true, isSecret: false },
      { key: "authenticationPreference", value: "device_code", isSet: true, isSecret: false }
    ]);
    assert.equal(await main(["provider", "config", "validate-json", fields, "--json"]), 0);
    assert.equal(await main(["provider", "config", "save-json", fields]), 0);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      codex?: { binaryPath?: string; codexHome?: string };
      runtimeProviders?: { providers?: { codex?: { settings?: { binaryPath?: string; codexHome?: string; authenticationPreference?: string } } } };
    };
    assert.equal(state.runtimeProviders?.providers?.codex?.settings?.binaryPath, fakeCodex);
    assert.equal(state.runtimeProviders?.providers?.codex?.settings?.codexHome, codexHome);
    assert.equal(state.runtimeProviders?.providers?.codex?.settings?.authenticationPreference, "device_code");
    assert.equal(state.codex?.binaryPath, undefined);
    assert.equal(state.codex?.codexHome, undefined);

    assert.equal(await main(["provider", "config", "reset", "codexHome"]), 0);
    const resetState = JSON.parse(readFileSync(statePath, "utf8")) as {
      runtimeProviders?: { providers?: { codex?: { settings?: { binaryPath?: string; codexHome?: string; authenticationPreference?: string } } } };
    };
    assert.equal(resetState.runtimeProviders?.providers?.codex?.settings?.binaryPath, fakeCodex);
    assert.equal(resetState.runtimeProviders?.providers?.codex?.settings?.codexHome, undefined);
    assert.equal(resetState.runtimeProviders?.providers?.codex?.settings?.authenticationPreference, "device_code");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App settings and headless model-alias CLI persist local state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-settings-alias-test-"));
  const statePath = join(root, "state.json");
  const previousEnv = snapshotEnv(["HUNSU_BRIDGE_APP_STATE_PATH"]);
  const previousLog = console.log;
  const logs: string[] = [];
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  try {
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;

    assert.equal(await main(["settings", "quit-behavior", "get"]), 0);
    assert.equal(logs.at(-1), "keep-background");
    assert.equal(await main(["settings", "quit-behavior", "set", "stop-background"]), 0);
    assert.equal(await main(["settings", "quit-behavior", "get"]), 0);
    assert.equal(logs.at(-1), "stop-background");
    const settingsState = JSON.parse(readFileSync(statePath, "utf8")) as { quitBehavior?: string };
    assert.equal(settingsState.quitBehavior, "stop-background");

    logs.length = 0;
    assert.equal(await main(["model-alias", "list", "--json"]), 0);
    const listed = JSON.parse(logs.at(-1) ?? "{}") as { aliases?: Array<{ scope?: { kind?: string } }> };
    assert.equal((listed.aliases ?? []).length > 0, true);
    assert.equal((listed.aliases ?? []).every(alias => alias.scope?.kind === "local"), true);

    assert.equal(await main(["model-alias", "set", "PrimaryModel", "--model", "gpt-5.5"]), 0);
    const aliasState = JSON.parse(readFileSync(statePath, "utf8")) as { modelAliases?: Array<{ aliasId?: string; scope?: { kind?: string } }> };
    assert.equal(aliasState.modelAliases?.find(alias => alias.aliasId === "PrimaryModel")?.scope?.kind, "local");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App desktop UI clears stale Codex login status after authentication", () => {
  const ui = loadBridgeDesktopUiForTest();
  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    codexLogin: {
      kind: "device",
      status: "device_code",
      state: "device_code",
      message: "Codex device login started.",
      verificationUriComplete: "https://auth.openai.com/activate?user_code=HUNSU-UI",
      userCode: "HUNSU-UI"
    },
    prerequisites: {
      codex: { ready: false, recommendedAction: "login_codex", auth: { state: "not_authenticated" } },
      tools: {}
    }
  });
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /HUNSU-UI/);

  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    prerequisites: {
      codex: { ready: true, recommendedAction: "none", auth: { state: "authenticated" } },
      tools: {}
    }
  });
  assert.doesNotMatch(textForTestElement(ui.elements.get("#codex-card")), /HUNSU-UI/);
});

test("Bridge App desktop UI preserves unauthenticated failure and renders ChatGPT pending state", () => {
  const ui = loadBridgeDesktopUiForTest();
  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    codexLogin: {
      kind: "device",
      status: "failed",
      state: "failed",
      message: "Codex device login failed.",
      error: "browser unavailable"
    },
    prerequisites: {
      codex: { ready: false, recommendedAction: "login_codex", auth: { state: "not_authenticated" } },
      tools: {}
    }
  });
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /browser unavailable/);

  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    codexLogin: {
      kind: "chatgpt",
      status: "pending",
      lastOutput: "Browser login started. Complete sign-in, then click Recheck."
    },
    prerequisites: {
      codex: { ready: false, recommendedAction: "login_codex", auth: { state: "not_authenticated" } },
      tools: {}
    }
  });
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /Codex login started/);
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /Complete sign-in in your browser, then click Recheck/);
});

test("Bridge App desktop UI keeps Local/Remote connection primary and provider placeholders Advanced", () => {
  const html = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-ui/index.html"), "utf8");
  const primaryNav = html.match(/<nav aria-label="Bridge sections">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.deepEqual([...primaryNav.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ["Provider", "Workspaces", "Connection"]);
  assert.doesNotMatch(primaryNav, /Overview|Advanced|Diagnostics|Settings/);
  const providerPanel = html.match(/<section data-panel="provider">([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.match(providerPanel, /<dt>Provider<\/dt>[\s\S]*<dt>Workspaces<\/dt>[\s\S]*<dt>Connection<\/dt>/);
  assert.doesNotMatch(providerPanel, /Account|Remote Access|Device|Service/);
  assert.match(html, /id="provider-config-form"/);
  assert.doesNotMatch(html, /id="codex-env-command"/);
  const appSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-ui/app.js"), "utf8");
  assert.doesNotMatch(appSource, /Copy Install Command/);
  assert.match(appSource, /\["codex", "install", "--confirm"\]/);
  assert.match(appSource, /\["codex", "login", "--api-key"\]/);
  assert.match(appSource, /metadata\.configKeys/);

  const ui = loadBridgeDesktopUiForTest();
  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    prerequisites: {
      codex: { ready: false, recommendedAction: "install_codex", auth: { state: "not_authenticated" } },
      tools: {}
    },
    providers: {
      currentProviderId: "codex",
      current: {
        providerId: "codex",
        label: "Codex",
        ready: true,
        recommendedAction: "none",
        auth: { state: "authenticated", access: "subscription" },
        install: { binaryPath: "/opt/codex/bin/codex", source: "custom", version: "codex 1.2.3" },
        usage: { available: true, summary: { label: "Available", remainingLabel: "plenty" } }
      },
      providers: [
        {
          providerId: "codex",
          label: "Codex",
          ready: true,
          recommendedAction: "none",
          auth: { state: "authenticated", access: "subscription" },
          install: { binaryPath: "/opt/codex/bin/codex", source: "custom", version: "codex 1.2.3" },
          usage: { available: true, summary: { label: "Available", remainingLabel: "plenty" } }
        },
        { providerId: "claude_code", label: "Claude Code", ready: false, recommendedAction: "configure", safeMessage: "Coming later" }
      ]
    },
    providerConfig: {
      providerId: "codex",
      metadata: {
        providerId: "codex",
        label: "Codex",
        description: "Codex provider",
        configKeys: [
          { name: "binaryPath", label: "Codex binary", kind: "file", required: false, secret: false, primary: true },
          { name: "codexHome", label: "Codex home", kind: "directory", required: false, secret: false, primary: true },
          {
            name: "authenticationPreference",
            label: "Authentication method",
            kind: "select",
            required: false,
            secret: false,
            primary: false,
            default: "chatgpt",
            options: [
              { value: "chatgpt", label: "ChatGPT" },
              { value: "device_code", label: "Device code" }
            ]
          },
          { name: "appServerCommand", label: "App-server command", kind: "text", required: false, secret: false, primary: false, advanced: true }
        ]
      },
      fields: [
        { key: "binaryPath", value: "/opt/codex/bin/codex", isSet: true, isSecret: false },
        { key: "codexHome", value: "/home/dev/.codex", isSet: true, isSecret: false },
        { key: "authenticationPreference", value: "device_code", isSet: true, isSecret: false },
        { key: "appServerCommand", value: "/opt/codex/bin/codex", isSet: true, isSecret: false }
      ]
    },
    codexSettings: { installChannel: "manual" },
    managedRoadmaps: [{
      roadmapId: "roadmap_ui",
      displayName: "UI Workspace",
      repositoryPath: "/tmp/hunsu-ui-workspace",
      lifecycle: "active",
      health: "ok",
      lastOpenedAt: "2026-07-09T00:00:00.000Z",
      provider: { providerId: "codex", label: "Codex", readyForExecute: true },
      codex: { readyForExecute: true },
      remoteAccess: {
        available: true,
        enabled: true,
        scopes: ["remoteRelay.access"],
        scopeState: {
          "execute.start": false,
          "artifactAction.run": false,
          "env.read": false,
          "hostAlias.expose": false,
          "remoteRelay.access": true
        }
      }
    }],
    projectGrants: [{
      path: "/tmp/hunsu-ui-workspace",
      grantedAt: "2026-07-09T00:00:00.000Z",
      scopes: ["remoteRelay.access"]
    }],
    runtimeProviders: {
      currentProviderId: "codex",
      providers: [
        { providerId: "codex", label: "Codex", ready: true, recommendedAction: "none" },
        { providerId: "claude_code", label: "Claude Code", ready: false, recommendedAction: "configure", safeMessage: "Coming later" }
      ]
    }
  });
  assert.match(textForTestElement(ui.elements.get("#codex-summary")), /Codex · Ready/);
  assert.match(textForTestElement(ui.elements.get("#local-bridge")), /Local · Connected/);
  assert.match(textForTestElement(ui.elements.get("#local-bridge")), /Remote · Off/);
  assert.match(textForTestElement(ui.elements.get("#connection-local-status")), /This computer · Connected/);
  assert.match(textForTestElement(ui.elements.get("#connection-remote-status")), /Sign in to use this computer/);
  const codexCard = ui.elements.get("#codex-card");
  assert.doesNotMatch(textForTestElement(codexCard), /Change provider/);
  assert.match(textForTestElement(codexCard), /Advanced provider details/);
  assert.doesNotMatch(textForTestElement(codexCard?.children[0]), /Use API Key - Advanced|\/opt\/codex\/bin\/codex|codex 1\.2\.3|Auth access|Rate limit summary/);
  assert.match(textForTestElement(codexCard?.children[1]), /Use API Key - Advanced/);
  assert.match(textForTestElement(codexCard?.children[1]), /Binary path: \/opt\/codex\/bin\/codex/);
  assert.match(textForTestElement(codexCard?.children[1]), /Source: custom/);
  assert.match(textForTestElement(codexCard?.children[1]), /Version: codex 1\.2\.3/);
  assert.match(textForTestElement(codexCard?.children[1]), /Auth access: Subscription/);
  assert.match(textForTestElement(codexCard?.children[1]), /Rate limit summary: Available, plenty/);
  assert.match(textForTestElement(ui.elements.get("#runtime-provider-list")), /Claude Code/);
  assert.match(textForTestElement(ui.elements.get("#runtime-provider-list")), /Coming later/);
  assert.match(textForTestElement(ui.elements.get("#provider-config-form")), /Codex binary/);
  assert.match(textForTestElement(ui.elements.get("#provider-config-form")), /Codex home/);
  assert.match(textForTestElement(ui.elements.get("#provider-config-form")), /Authentication method/);
  assert.match(textForTestElement(ui.elements.get("#provider-config-form")), /App-server command/);
  assert.doesNotMatch(textForTestElement(ui.elements.get("#active-roadmap-list")), /remoteRelay\.access|\/tmp\/hunsu-ui-workspace/);
  assert.match(textForTestElement(ui.elements.get("#remote-roadmap-list")), /remoteRelay\.access/);

  ui.renderSnapshot({
    status: {
      ...bridgeUiStatusFixture(),
      localBridge: "not-running"
    },
    prerequisites: {
      codex: { ready: true, recommendedAction: "none" },
      tools: {}
    },
    providers: {
      currentProviderId: "codex",
      current: { providerId: "codex", label: "Codex", ready: true, recommendedAction: "none", auth: { state: "authenticated" } },
      providers: [{ providerId: "codex", label: "Codex", ready: true, recommendedAction: "none" }]
    }
  });
  assert.match(textForTestElement(ui.elements.get("#local-bridge")), /Local · Connecting/);
  assert.doesNotMatch(textForTestElement(ui.elements.get("#local-bridge")), /Not Running/);

  ui.renderSnapshot({
    status: bridgeUiStatusFixture(),
    prerequisites: {
      codex: { ready: false, recommendedAction: "recheck", auth: { state: "error" } },
      tools: {}
    },
    providers: {
      currentProviderId: "codex",
      current: { providerId: "codex", label: "Codex", ready: false, recommendedAction: "recheck", safeMessage: "Codex needs attention." },
      providers: [{ providerId: "codex", label: "Codex", ready: false, recommendedAction: "recheck", safeMessage: "Codex needs attention." }]
    }
  });
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /Recheck/);
  assert.doesNotMatch(textForTestElement(ui.elements.get("#codex-card")), /Select Existing Codex|Show details/);
  assert.match(textForTestElement(ui.elements.get("#codex-card")), /Advanced provider details/);

  ui.renderSnapshot({
    status: {
      ...bridgeUiStatusFixture(),
      account: "Signed in as dev@example.test",
      remoteAccess: "On",
      device: { name: "MacBook Pro", registered: true }
    },
    workspaces: {
      active: [{ lifecycle: "active" }, { lifecycle: "active" }],
      inactive: [],
      managed: []
    },
    prerequisites: {
      codex: { ready: true, recommendedAction: "none", auth: { state: "authenticated" } },
      tools: {}
    }
  });
  assert.match(textForTestElement(ui.elements.get("#connection-remote-status")), /Remote · On/);
  assert.match(textForTestElement(ui.elements.get("#connection-remote-detail")), /Device: MacBook Pro/);
  assert.match(textForTestElement(ui.elements.get("#connection-remote-detail")), /Published workspaces: 2/);
  assert.doesNotMatch(textForTestElement(ui.elements.get("#connection-remote-detail")), /Status: Online/);
});

test("Bridge App command and state modules are imported by the desktop entrypoint", () => {
  const root = process.cwd();
  const mainSource = readFileSync(join(root, "apps/bridge-desktop/src/main.ts"), "utf8");
  for (const modulePath of [
    "./commands/codexCommands.ts",
    "./commands/authCommands.ts",
    "./commands/providerCommands.ts",
    "./commands/workspaceCommands.ts",
    "./commands/connectionCommands.ts",
    "./commands/diagnosticsCommands.ts",
    "./processes/backgroundSpawn.ts",
    "./state/appState.ts"
  ]) {
    assert.match(mainSource, new RegExp(modulePath.replaceAll(".", "\\.").replaceAll("/", "\\/")));
  }
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/commands/codexCommands.ts"), "utf8"), /runCodexCommand/);
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/commands/authCommands.ts"), "utf8"), /runLoginCommand/);
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/commands/providerCommands.ts"), "utf8"), /providerStatusSummary/);
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/commands/workspaceCommands.ts"), "utf8"), /runRoadmapsCommand/);
  const connectionSource = readFileSync(join(root, "apps/bridge-desktop/src/commands/connectionCommands.ts"), "utf8");
  assert.match(connectionSource, /runRemoteCommand/);
  assert.match(connectionSource, /publishProjectGrantsToRelay/);
  assert.match(connectionSource, /attachRemoteAccessCommand/);
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/commands/diagnosticsCommands.ts"), "utf8"), /runDiagnosticsCommand/);
  const backgroundSpawnSource = readFileSync(join(root, "apps/bridge-desktop/src/processes/backgroundSpawn.ts"), "utf8");
  assert.match(backgroundSpawnSource, /startDetachedRemoteAccessProcess/);
  assert.match(backgroundSpawnSource, /createBridgeAppSidecarSupervisor/);
  assert.match(readFileSync(join(root, "apps/bridge-desktop/src/state/appState.ts"), "utf8"), /defaultBridgeAppState/);
  assert.doesNotMatch(mainSource, /function publishProjectGrantsToRelay/);
  assert.doesNotMatch(mainSource, /function startRemoteAccessProcessIfPossible/);
  assert.doesNotMatch(mainSource, /function createBridgeAppSidecarSupervisor/);
});

test("Bridge App background child spawns hide Windows console windows", () => {
  const codexSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src/commands/codexCommands.ts"), "utf8");
  const backgroundSpawnSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src/processes/backgroundSpawn.ts"), "utf8");
  const sidecarSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src/sidecar-supervisor.ts"), "utf8");
  const bridgeSource = [
    readFileSync(join(process.cwd(), "apps/bridge/src/index.ts"), "utf8"),
    readFileSync(join(process.cwd(), "apps/bridge/src/runtime-providers/codex.ts"), "utf8"),
    readFileSync(join(process.cwd(), "apps/bridge/src/runtime-providers/codex/codexLogin.ts"), "utf8"),
    readFileSync(join(process.cwd(), "apps/bridge/src/runtime-providers/codex/codexProvider.ts"), "utf8")
  ].join("\n");
  assert.ok(([codexSource, backgroundSpawnSource].join("\n").match(/detached: true[\s\S]{0,180}windowsHide: true/g) ?? []).length >= 3);
  assert.match(sidecarSource, /stdio: \["ignore", "pipe", "pipe"\],[\s\S]{0,80}windowsHide: true/);
  assert.ok((bridgeSource.match(/detached: true[\s\S]{0,180}windowsHide: true/g) ?? []).length >= 3);
});

test("Bridge App headless commands persist device, Remote Access, Project Grant, and service state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-app-test-"));
  const statePath = join(root, "state.json");
  const credentialPath = join(root, "credentials.json");
  const relayRegistryPath = join(root, "relay.json");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const serviceUnitPath = join(root, "hunsu-bridge.service");
  const logPath = join(root, "bridge-app.log");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousCredentialPath = process.env.HUNSU_BRIDGE_CREDENTIAL_PATH;
  const previousRelayRegistryPath = process.env.HUNSU_RELAY_REGISTRY_PATH;
  const previousRoadmapRegistryPath = process.env.HUNSU_ROADMAP_REGISTRY_PATH;
  const previousServiceUnitPath = process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousDevUser = process.env.HUNSU_BRIDGE_DEV_USER;
  const previousServiceDryRun = process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN;
  const logs: string[] = [];
  const previousLog = console.log;

  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = credentialPath;
  process.env.HUNSU_RELAY_REGISTRY_PATH = relayRegistryPath;
  process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
  process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = serviceUnitPath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  process.env.HUNSU_BRIDGE_DEV_USER = "dev@example.test";
  process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN = "1";
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    assert.equal(await main(["login"]), 0);
    assert.equal(await main(["remote", "enable"]), 0);
    assert.equal(await main(["projects", "grant", root]), 0);
    writeFileSync(roadmapRegistryPath, JSON.stringify({
      version: 1,
      roadmaps: [{
        roadmapId: "roadmap_missing",
        displayName: "Missing Roadmap",
        repositoryPath: join(root, "missing-roadmap"),
        lastOpenedAt: new Date().toISOString(),
        health: "ok"
      }]
    }), "utf8");
    assert.equal(await main(["remote", "check", "bridge.status"]), 1);
    assert.equal(await main(["projects", "remove", "--roadmap-id", "roadmap_missing"]), 0);
    assert.equal(await main(["remote", "check", "execute.start", root]), 1);
    assert.equal(await main(["service", "install"]), 0);
    assert.equal(await main(["service", "start"]), 0);
    assert.equal(await main(["service", "stop"]), 0);
    assert.equal(await main(["status"]), 0);
    assert.equal(await main(["snapshot"]), 0);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      account: { status: string; email?: string };
      device: { registered: boolean };
      remoteAccess: string;
      projectGrants: Array<{ path: string; scopes: string[] }>;
      service: { installed: boolean; manager: string };
    };
    const snapshot = JSON.parse(logs.at(-1) ?? "{}") as {
      providers?: { current?: { providerId?: string; label?: string } };
      workspaces?: { active?: unknown[]; managed?: unknown[] };
      connections?: { local?: { state?: string }; remote?: { state?: string } };
      projectGrants?: Array<{ path: string; scopes: string[] }>;
      diagnostics?: { app?: { projectGrants?: Array<{ path: string; scopes: string[] }> } };
    };

    assert.deepEqual(state.account, { status: "signed-in", userId: "dev@example.test", email: "dev@example.test" });
    assert.equal(state.device.registered, true);
    assert.equal(state.remoteAccess, "registered-offline");
    assert.equal(state.projectGrants[0]?.path, root);
    assert.equal(state.projectGrants[0]?.scopes.includes("execute.start"), true);
    assert.equal(state.projectGrants[0]?.scopes.includes("env.read"), true);
    assert.equal(state.projectGrants[0]?.scopes.includes("hostAlias.expose"), true);
    assert.equal(state.projectGrants[0]?.scopes.includes("remoteRelay.access"), true);
    assert.equal(snapshot.providers?.current?.providerId, "codex");
    assert.equal(Array.isArray(snapshot.workspaces?.active), true);
    assert.equal(Array.isArray(snapshot.workspaces?.managed), true);
    assert.equal(snapshot.connections?.local?.state === "connected" || snapshot.connections?.local?.state === "not-running", true);
    assert.equal(snapshot.connections?.remote?.state, "registered-offline");
    assert.equal(snapshot.projectGrants?.[0]?.path, root);
    assert.equal(snapshot.diagnostics?.app?.projectGrants?.[0]?.path, root);
    assert.equal(state.service.installed, true);
    assert.match(state.service.manager, /systemd-user|launchd-user|windows-startup-user|manual/);
    if (process.platform === "linux") {
      assert.match(readFileSync(serviceUnitPath, "utf8"), /ExecStart=.*"?supervise"? "?--cwd"?/);
    }
    assert.equal(logs.some(line => line.includes("Remote Access: Registered but offline")), true);
    assert.equal(logs.some(line => line.includes("Provider:")), true);
    assert.equal(logs.some(line => line.includes("Active Workspaces:")), true);
    assert.equal(logs.some(line => line.includes("Inactive Workspaces:")), true);
    assert.equal(logs.some(line => line.includes("Projects:")), false);
    assert.equal(existsSync(credentialPath), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialPath).mode & 0o077, 0);
    }
    const relay = new FileRelayRegistry(relayRegistryPath);
    assert.equal(relay.listDevices("dev@example.test")[0]?.status, "offline");
    const roadmapRegistry = JSON.parse(readFileSync(roadmapRegistryPath, "utf8")) as { roadmaps: unknown[] };
    assert.deepEqual(roadmapRegistry.roadmaps, []);
  } finally {
    console.log = previousLog;
    if (previousStatePath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    }
    if (previousCredentialPath === undefined) {
      delete process.env.HUNSU_BRIDGE_CREDENTIAL_PATH;
    } else {
      process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = previousCredentialPath;
    }
    if (previousRelayRegistryPath === undefined) {
      delete process.env.HUNSU_RELAY_REGISTRY_PATH;
    } else {
      process.env.HUNSU_RELAY_REGISTRY_PATH = previousRelayRegistryPath;
    }
    if (previousRoadmapRegistryPath === undefined) {
      delete process.env.HUNSU_ROADMAP_REGISTRY_PATH;
    } else {
      process.env.HUNSU_ROADMAP_REGISTRY_PATH = previousRoadmapRegistryPath;
    }
    if (previousServiceUnitPath === undefined) {
      delete process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
    } else {
      process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = previousServiceUnitPath;
    }
    if (previousLogPath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    }
    if (previousDevUser === undefined) {
      delete process.env.HUNSU_BRIDGE_DEV_USER;
    } else {
      process.env.HUNSU_BRIDGE_DEV_USER = previousDevUser;
    }
    if (previousServiceDryRun === undefined) {
      delete process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN;
    } else {
      process.env.HUNSU_BRIDGE_SERVICE_DRY_RUN = previousServiceDryRun;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Project Grants accept explicit env and host alias scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-grant-scope-test-"));
  const statePath = join(root, "state.json");
  const logPath = join(root, "bridge-app.log");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousLog = console.log;
  console.log = () => undefined;
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;

  try {
    assert.equal(await main(["projects", "grant", root, "--scopes", "env.read,hostAlias.expose"]), 0);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      projectGrants: Array<{ path: string; scopes: string[] }>;
    };
    assert.equal(state.projectGrants[0]?.path, root);
    assert.deepEqual(state.projectGrants[0]?.scopes, ["env.read", "hostAlias.expose"]);
  } finally {
    console.log = previousLog;
    if (previousStatePath === undefined) delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    else process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Project Grant revoke publishes an empty grant list to Relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-revoke-relay-test-"));
  const statePath = join(root, "state.json");
  const credentialPath = join(root, "credentials.json");
  const logPath = join(root, "bridge-app.log");
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  let relayRequest: { authorization?: string; body?: any } | undefined;
  const relay = createHttpServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/devices") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      relayRequest = {
        authorization: request.headers.authorization,
        body
      };
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ device: body.device }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const envKeys = [
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_BACKEND",
    "HUNSU_RELAY_PUBLIC_API_URL"
  ];
  const previousEnv = snapshotEnv(envKeys);
  const previousLog = console.log;
  console.log = () => undefined;
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", () => resolve());
  });
  const address = relay.address();
  assert.ok(address && typeof address === "object");

  try {
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = credentialPath;
    process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
    process.env.HUNSU_BRIDGE_CREDENTIAL_BACKEND = "secure-file";
    process.env.HUNSU_RELAY_PUBLIC_API_URL = `http://127.0.0.1:${address.port}`;
    writeFileSync(statePath, JSON.stringify({
      schema: "hunsu.bridge-app-state.v1",
      account: { status: "signed-in", userId: "user_123", email: "user@example.test" },
      device: { id: "device_123", name: "devbox", registered: true },
      remoteAccess: "on",
      projectGrants: [{
        path: projectPath,
        grantedAt: new Date().toISOString(),
        scopes: ["execute.start", "remoteRelay.access"]
      }],
      service: { installed: false, manager: "systemd-user" }
    }), "utf8");
    new FileCredentialStore(credentialPath).write({
      schema: "hunsu.bridge-credentials.v1",
      accessToken: "access_123",
      userId: "user_123",
      email: "user@example.test",
      deviceId: "device_123",
      deviceName: "devbox",
      savedAt: new Date().toISOString()
    });

    assert.equal(await main(["projects", "revoke", projectPath]), 0);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { projectGrants?: unknown[] };
    assert.deepEqual(state.projectGrants, []);
    assert.equal(relayRequest?.authorization, "Bearer access_123");
    assert.deepEqual(relayRequest?.body?.projectGrants, []);
    assert.equal(relayRequest?.body?.device?.deviceId, "device_123");
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    await new Promise<void>((resolve, reject) => {
      relay.close(error => error ? reject(error) : resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App publishes only active managed Roadmap grants to Relay", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-active-grants-relay-test-"));
  const statePath = join(root, "state.json");
  const credentialPath = join(root, "credentials.json");
  const logPath = join(root, "bridge-app.log");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const activePath = join(root, "active-project");
  const inactivePath = join(root, "inactive-project");
  const state = createStudioState();
  const active = createStudioRoadmap({ path: activePath, title: "Active Roadmap" }, state, { persist: true, roadmapRegistryPath });
  const inactive = createStudioRoadmap({ path: inactivePath, title: "Inactive Roadmap" }, state, { persist: true, roadmapRegistryPath });
  setRoadmapLifecycle({ roadmapId: inactive.roadmap.roadmapId }, "inactive", { roadmapRegistryPath });
  let relayRequest: { body?: any } | undefined;
  const relay = createHttpServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/devices") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      relayRequest = { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ device: relayRequest.body.device }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const previousEnv = snapshotEnv([
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_BACKEND",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_RELAY_PUBLIC_API_URL"
  ]);
  const previousLog = console.log;
  console.log = () => undefined;
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", () => resolve());
  });
  const address = relay.address();
  assert.ok(address && typeof address === "object");

  try {
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.HUNSU_BRIDGE_CREDENTIAL_PATH = credentialPath;
    process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
    process.env.HUNSU_BRIDGE_CREDENTIAL_BACKEND = "secure-file";
    process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
    process.env.HUNSU_RELAY_PUBLIC_API_URL = `http://127.0.0.1:${address.port}`;
    writeFileSync(statePath, JSON.stringify({
      schema: "hunsu.bridge-app-state.v1",
      account: { status: "signed-in", userId: "user_123", email: "user@example.test" },
      device: { id: "device_123", name: "devbox", registered: true },
      remoteAccess: "on",
      projectGrants: [
        { path: activePath, grantedAt: new Date().toISOString(), scopes: ["execute.start", "remoteRelay.access"] },
        { path: inactivePath, grantedAt: new Date().toISOString(), scopes: ["execute.start", "remoteRelay.access"] },
        { path: join(root, "unmanaged-project"), grantedAt: new Date().toISOString(), scopes: ["execute.start", "remoteRelay.access"] }
      ],
      service: { installed: false, manager: "systemd-user" }
    }), "utf8");
    new FileCredentialStore(credentialPath).write({
      schema: "hunsu.bridge-credentials.v1",
      accessToken: "access_123",
      userId: "user_123",
      email: "user@example.test",
      deviceId: "device_123",
      deviceName: "devbox",
      savedAt: new Date().toISOString()
    });

    assert.equal(await main(["remote", "enable"]), 0);
    const published = relayRequest?.body?.projectGrants as ProjectGrant[] | undefined;
    assert.deepEqual(published?.map(grant => grant.path), [activePath]);
    assert.equal(relayRequest?.body?.device?.provider?.providerId, "codex");
    assert.equal(relayRequest?.body?.device?.provider?.modelInventory?.state, "available");
    assert.deepEqual(
      relayRequest?.body?.device?.provider?.modelInventory?.models?.map((model: { model: string }) => model.model),
      ["codex-default", "gpt-5.5-thinking", "gpt-5.5"]
    );
    assert.deepEqual(relayRequest?.body?.device?.projectGrants?.map((grant: ProjectGrant) => grant.path), [activePath]);
    assert.deepEqual(relayRequest?.body?.device?.workspaces?.map((workspace: { workspaceId: string }) => workspace.workspaceId), [active.roadmap.roadmapId]);
    assert.equal(relayRequest?.body?.device?.workspaces?.some((workspace: { workspaceId: string }) => workspace.workspaceId === inactive.roadmap.roadmapId), false);
    assert.equal(relayRequest?.body?.device?.workspaces?.[0]?.path, undefined);
    assert.equal(relayRequest?.body?.device?.workspaces?.[0]?.pathRedacted, true);
    assert.equal(typeof relayRequest?.body?.device?.lastSnapshotAt, "string");
    assert.deepEqual(relayRequest?.body?.workspaces?.map((workspace: { workspaceId: string }) => workspace.workspaceId), [active.roadmap.roadmapId]);
    assert.equal(typeof relayRequest?.body?.lastSnapshotAt, "string");

    assert.equal(await main(["remote", "disable"]), 0);
    const disabledState = JSON.parse(readFileSync(statePath, "utf8")) as { remoteAccess?: string; projectGrants?: ProjectGrant[] };
    assert.equal(disabledState.remoteAccess, "off");
    assert.equal(disabledState.projectGrants?.some(grant => grant.scopes.includes("remoteRelay.access")), false);
    const disabledActive = listManagedRoadmapRegistry({ roadmapRegistryPath }).find(roadmap => roadmap.roadmapId === active.roadmap.roadmapId);
    assert.equal(disabledActive?.remoteAccess?.enabled, false);
    assert.equal(disabledActive?.remoteAccess?.scopes.includes("remoteRelay.access"), false);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    await new Promise<void>((resolve, reject) => {
      relay.close(error => error ? reject(error) : resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Roadmaps CLI manages per-Roadmap Remote Access state and scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-roadmap-remote-test-"));
  const statePath = join(root, "state.json");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const logPath = join(root, "bridge-app.log");
  const activePath = join(root, "active-project");
  const inactivePath = join(root, "inactive-project");
  const state = createStudioState();
  const active = createStudioRoadmap({ path: activePath, title: "Active Roadmap" }, state, { persist: true, roadmapRegistryPath });
  const inactive = createStudioRoadmap({ path: inactivePath, title: "Inactive Roadmap" }, state, { persist: true, roadmapRegistryPath });
  setRoadmapLifecycle({ roadmapId: inactive.roadmap.roadmapId }, "inactive", { roadmapRegistryPath });
  const previousEnv = snapshotEnv([
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_CODEX_BINARY_PATH"
  ]);
  const logs: string[] = [];
  const errors: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };
  try {
    process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
    process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
    process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
    process.env.HUNSU_CODEX_BINARY_PATH = join(root, "missing-codex");

    assert.equal(await main(["roadmaps", "remote", "enable", active.roadmap.roadmapId, "--scopes", "remoteRelay.access,execute.start"]), 0);
    const enabledState = JSON.parse(readFileSync(statePath, "utf8")) as { projectGrants?: ProjectGrant[] };
    assert.deepEqual(enabledState.projectGrants?.[0], {
      path: activePath,
      grantedAt: enabledState.projectGrants?.[0]?.grantedAt,
      scopes: ["remoteRelay.access", "execute.start"]
    });

    logs.length = 0;
    assert.equal(await main(["roadmaps", "list", "--json"]), 0);
    const listed = JSON.parse(logs.at(-1) ?? "{}") as {
      roadmaps?: Array<{
        roadmapId: string;
        codex?: { readyForExecute?: boolean };
        remoteAccess?: { enabled?: boolean; available?: boolean; scopeState?: Record<string, boolean> };
      }>;
    };
    const activeRow = listed.roadmaps?.find(roadmap => roadmap.roadmapId === active.roadmap.roadmapId);
    const inactiveRow = listed.roadmaps?.find(roadmap => roadmap.roadmapId === inactive.roadmap.roadmapId);
    assert.equal(activeRow?.codex?.readyForExecute, false);
    assert.equal(activeRow?.remoteAccess?.enabled, true);
    assert.equal(activeRow?.remoteAccess?.scopeState?.["remoteRelay.access"], true);
    assert.equal(activeRow?.remoteAccess?.scopeState?.["execute.start"], true);
    assert.equal(inactiveRow?.remoteAccess?.available, false);

    assert.equal(await main(["roadmaps", "remote", "enable", inactive.roadmap.roadmapId]), 1);
    assert.match(errors.at(-1) ?? "", /Inactive Roadmap cannot be exposed/);

    assert.equal(await main(["roadmaps", "remote", "disable", active.roadmap.roadmapId]), 0);
    const disabledState = JSON.parse(readFileSync(statePath, "utf8")) as { projectGrants?: ProjectGrant[] };
    assert.deepEqual(disabledState.projectGrants?.[0]?.scopes, ["execute.start"]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App service install dry-run does not persist installed state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-service-dry-run-test-"));
  const statePath = join(root, "state.json");
  const unitPath = join(root, "hunsu-bridge.service");
  const logPath = join(root, "bridge-app.log");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousServiceUnitPath = process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousLog = console.log;
  const logs: string[] = [];
  const manager = process.platform === "darwin"
    ? "launchd-user"
    : process.platform === "win32"
      ? "windows-startup-user"
      : process.platform === "linux"
        ? "systemd-user"
        : "manual";

  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = unitPath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    writeFileSync(statePath, JSON.stringify({
      schema: "hunsu.bridge-app-state.v1",
      account: { status: "signed-out" },
      device: { id: "device_test", name: "test", registered: false },
      remoteAccess: "off",
      projectGrants: [],
      service: { installed: false, manager }
    }, null, 2), "utf8");
    assert.equal(await main(["service", "install", "--dry-run", "--cwd", root]), 0);

    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      diagnosticsSecurityVersion?: number;
      service?: { installed?: boolean; manager?: string };
    };
    assert.equal(persisted.diagnosticsSecurityVersion, 1);
    assert.deepEqual(persisted.service, { installed: false, manager });
    assert.equal(existsSync(unitPath), false);
    assert.equal(logs.some(line => line.includes("Dry run:")), true);
    assert.equal(logs.some(line => line.includes("Installed Hunsu Bridge service artifact")), false);
  } finally {
    console.log = previousLog;
    if (previousStatePath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    }
    if (previousServiceUnitPath === undefined) {
      delete process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
    } else {
      process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = previousServiceUnitPath;
    }
    if (previousLogPath === undefined) {
      delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    } else {
      process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App user service managers preserve provider env on Windows and macOS", () => {
  const source = readFileSync(join(process.cwd(), "apps/bridge-desktop/src/main.ts"), "utf8");
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /Start-ScheduledTask/);
  assert.match(source, /Stop-ScheduledTask/);
  assert.match(source, /Unregister-ScheduledTask/);
  assert.match(source, /windowsUserStartupScriptText/);
  assert.match(source, /set "\$\{key\}=\$\{windowsBatchValue\(value\)\}"/);
  assert.match(source, /launchctl", "bootstrap"/);
  assert.match(source, /launchctl", "kickstart"/);
  assert.match(source, /launchctl", "bootout"/);
  assert.match(source, /serviceEnvironmentSnapshot/);
  assert.match(source, /codexProviderEnv/);
  assert.match(source, /bridgeCodexProviderSettings\(state\)/);
  assert.match(source, /HUNSU_BRIDGE_HEADLESS/);
  assert.match(source, /hasFlag\(parsed, "system"\) \? "manual" : defaultBridgeServiceManager/);
});

test("Bridge App Codex install requires confirmation and supports dry-run", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-install-dry-run-test-"));
  const previousEnv = {
    PATH: process.env.PATH,
    HUNSU_CODEX_BINARY_PATH: process.env.HUNSU_CODEX_BINARY_PATH,
    HUNSU_CODEX_INSTALL_DRY_RUN: process.env.HUNSU_CODEX_INSTALL_DRY_RUN
  };
  const previousLog = console.log;
  const logs: string[] = [];
  process.env.PATH = join(root, "missing-path");
  delete process.env.HUNSU_CODEX_BINARY_PATH;
  process.env.HUNSU_CODEX_INSTALL_DRY_RUN = "1";
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    assert.equal(await main(["codex", "install"]), 0);
    assert.equal(logs.some(line => line.includes("Confirm Codex installation")), true);
    assert.equal(logs.some(line => line.includes("--confirm")), true);
    logs.length = 0;

    assert.equal(await main(["codex", "install", "--confirm", "--dry-run"]), 0);
    assert.equal(logs.some(line => line.includes("dry run completed")), true);
    assert.equal(logs.some(line => line.includes("npm install -g @openai/codex@latest") || line.includes("npm.cmd install -g @openai/codex@latest")), true);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Codex API-key login invokes API-key path", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-codex-api-key-test-"));
  const fakeCodex = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  const argsPath = join(root, "args.txt");
  const previousEnv = {
    PATH: process.env.PATH,
    HUNSU_CODEX_BINARY_PATH: process.env.HUNSU_CODEX_BINARY_PATH
  };
  const previousLog = console.log;
  const logs: string[] = [];
  writeFileSync(fakeCodex, [
    `#!${process.execPath}`,
    "const { writeFileSync } = require('node:fs');",
    `const argsPath = ${JSON.stringify(argsPath)};`,
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex 2.0.0'); process.exit(0); }",
    "if (args[0] === 'login') { writeFileSync(argsPath, args.join(' ')); process.exit(0); }",
    "process.exit(0);",
    ""
  ].join("\n"), "utf8");
  chmodSync(fakeCodex, 0o755);
  process.env.HUNSU_CODEX_BINARY_PATH = fakeCodex;
  process.env.PATH = root;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    assert.equal(await main(["codex", "login", "--api-key"]), 0);
    await waitFor(() => existsSync(argsPath));
    assert.equal(readFileSync(argsPath, "utf8"), "login --api-key");
    assert.equal(logs.some(line => line.includes("API-key configuration started")), true);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App stop clears stale PID state without killing an unrelated process", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-stale-pid-test-"));
  const statePath = join(root, "state.json");
  const logPath = join(root, "bridge-app.log");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  const previousLog = console.log;
  const logs: string[] = [];
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };
  try {
    writeFileSync(statePath, JSON.stringify({
      schema: "hunsu.bridge-app-state.v1",
      pid: process.pid,
      bridgeApiUrl: "http://127.0.0.1:9",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      account: { status: "signed-out" },
      device: { id: "device_test", name: "test", registered: false },
      remoteAccess: "off",
      projectGrants: [],
      service: { installed: false, manager: "systemd-user" }
    }), "utf8");
    assert.equal(await main(["stop"]), 0);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number; bridgeApiUrl?: string; account?: unknown; device?: unknown };
    assert.equal(state.pid, undefined);
    assert.equal(state.bridgeApiUrl, undefined);
    assert.ok(state.account);
    assert.ok(state.device);
    assert.equal(logs.some(line => line.includes("already stopped")), true);
  } finally {
    console.log = previousLog;
    if (previousStatePath === undefined) delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    else process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App health check rejects non-Hunsu health responses", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-fake-health-test-"));
  const server = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "not-hunsu" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const logs: string[] = [];
  const previousLog = console.log;
  const envKeys = [
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_BRIDGE_HOST",
    "HUNSU_BRIDGE_PORT"
  ];
  const previousEnv = snapshotEnv(envKeys);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  process.env.HUNSU_BRIDGE_APP_STATE_PATH = join(root, "state.json");
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = join(root, "bridge-app.log");
  process.env.HUNSU_ROADMAP_REGISTRY_PATH = join(root, "roadmaps.json");
  process.env.HUNSU_BRIDGE_HOST = "127.0.0.1";
  process.env.HUNSU_BRIDGE_PORT = String(address.port);
  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };

  try {
    assert.equal(await main(["snapshot"]), 0);
    const snapshot = JSON.parse(logs.at(-1) ?? "{}") as {
      status?: { localBridge?: string; healthError?: string };
    };
    assert.equal(snapshot.status?.localBridge, "error");
    assert.notEqual(snapshot.status?.localBridge, "connected");
    assert.match(snapshot.status?.healthError ?? "", /owned by another service/);
  } finally {
    console.log = previousLog;
    restoreEnv(previousEnv);
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App systemd service artifact escapes special paths", async () => {
  if (process.platform !== "linux") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-service-escape-test-"));
  const unitPath = join(root, "hunsu-bridge.service");
  const cwd = join(root, "project with spaces \"quote\" and 100%");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousServiceUnitPath = process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = join(root, "state.json");
  process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = unitPath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = join(root, "bridge-app.log");
  try {
    assert.equal(await main(["service", "install", "--cwd", cwd]), 0);
    const text = readFileSync(unitPath, "utf8");
    assert.match(text, /WorkingDirectory="/);
    assert.match(text, /project with spaces/);
    assert.match(text, /\\"quote\\"/);
    assert.match(text, /100%%/);
    assert.match(text, /ExecStart=".*" ".*" "supervise" "--cwd" "/);
    assert.match(text, /Environment="HUNSU_BRIDGE_HEADLESS=1"/);
    assert.match(text, /Environment="HUNSU_BRIDGE_APP_STATE_PATH=/);
  } finally {
    if (previousStatePath === undefined) delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    else process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    if (previousServiceUnitPath === undefined) delete process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH;
    else process.env.HUNSU_BRIDGE_SERVICE_UNIT_PATH = previousServiceUnitPath;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App auth foundation creates PKCE, device flow, and secure file credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-auth-test-"));
  const credentialPath = join(root, "credentials.json");
  try {
    const pkce = createPkceAuthorizationRequest({
      clientId: "hunsu-bridge-app",
      redirectUri: "hunsu://pair",
      scope: "bridge relay"
    });
    assert.match(pkce.authorizationUrl, /code_challenge_method=S256/);
    assert.ok(pkce.codeVerifier.length > 30);
    assert.ok(pkce.codeChallenge.length > 30);

    const device = createDeviceAuthorizationRequest({ ttlSeconds: 60 });
    assert.match(device.verificationUri, /^https:\/\/hunsu\.app\/device/);
    assert.match(device.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const store = new FileCredentialStore(credentialPath);
    store.write({
      schema: "hunsu.bridge-credentials.v1",
      accessToken: "access",
      userId: "user_123",
      deviceId: "device_123",
      deviceName: "test-device",
      savedAt: new Date().toISOString()
    });
    assert.equal(store.read()?.userId, "user_123");
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialPath).mode & 0o077, 0);
    }
    store.clear();
    assert.equal(store.read(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App auth uses OS credential adapters and exchanges GUI callback tokens", async () => {
  const macCalls: Array<{ command: string; args: string[]; input?: string }> = [];
  const macStore = new MacOsKeychainCredentialStore({
    runner: (command, args, options) => {
      macCalls.push({ command, args, input: options?.input });
      if (args[0] === "find-generic-password") {
        return JSON.stringify({
          schema: "hunsu.bridge-credentials.v1",
          accessToken: "access",
          userId: "user_123",
          deviceId: "device_123",
          deviceName: "mac",
          savedAt: new Date().toISOString()
        });
      }
      return "";
    }
  });
  assert.equal(macStore.read()?.userId, "user_123");
  macStore.write({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "user_123",
    deviceId: "device_123",
    deviceName: "mac",
    savedAt: new Date().toISOString()
  });
  assert.equal(macCalls.some(call => call.command === "security" && call.args.includes("add-generic-password")), true);

  const linuxCalls: Array<{ command: string; args: string[]; input?: string }> = [];
  const linuxStore = new LinuxSecretServiceCredentialStore({
    runner: (command, args, options) => {
      linuxCalls.push({ command, args, input: options?.input });
      return JSON.stringify({
        schema: "hunsu.bridge-credentials.v1",
        accessToken: "access",
        userId: "linux-user",
        deviceId: "device_123",
        deviceName: "linux",
        savedAt: new Date().toISOString()
      });
    }
  });
  assert.equal(linuxStore.read()?.userId, "linux-user");
  linuxStore.write({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "linux-user",
    deviceId: "device_123",
    deviceName: "linux",
    savedAt: new Date().toISOString()
  });
  assert.equal(linuxCalls.some(call => call.command === "secret-tool" && call.args[0] === "store" && call.input?.includes("linux-user")), true);

  const windowsStore = new WindowsDpapiCredentialStore("C:\\Users\\dev\\bridge-credentials.txt", () => JSON.stringify({
    schema: "hunsu.bridge-credentials.v1",
    accessToken: "access",
    userId: "windows-user",
    deviceId: "device_123",
    deviceName: "windows",
    savedAt: new Date().toISOString()
  }));
  assert.equal(windowsStore.backend, "windows-dpapi");

  const credentials = await exchangeAuthorizationCode({
    authBaseUrl: "https://auth.example.test",
    clientId: "hunsu-bridge-app",
    code: "code_123",
    codeVerifier: "verifier",
    redirectUri: "hunsu://pair",
    deviceId: "device_123",
    deviceName: "devbox",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://auth.example.test/oauth/token");
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({
        access_token: "access_token",
        refresh_token: "refresh_token",
        expires_in: 60,
        user_id: "user_123",
        email: "dev@example.test"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(credentials.userId, "user_123");
  assert.equal(credentials.email, "dev@example.test");
  assert.equal(credentials.deviceId, "device_123");
});

test("Bridge App device flow polls and persists credentials from local dev auth provider", async () => {
  const server = await startLocalDevAuthServer({ userId: "device-user@example.test" });
  try {
    const request = await startDeviceAuthorization({
      authBaseUrl: server.authBaseUrl,
      clientId: "hunsu-bridge-headless",
      scope: "bridge device relay",
      deviceId: "device_123",
      deviceName: "devbox"
    });
    assert.match(request.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const pending = pollDeviceAuthorization({
      authBaseUrl: server.authBaseUrl,
      clientId: "hunsu-bridge-headless",
      deviceCode: request.deviceCode,
      deviceId: "device_123",
      deviceName: "devbox",
      intervalSeconds: request.intervalSeconds,
      expiresAt: request.expiresAt,
      maxWaitMs: 2000,
      sleep: async () => {
        await delay(5);
      }
    });
    await fetch(request.verificationUriComplete ?? `${request.verificationUri}?user_code=${encodeURIComponent(request.userCode)}`);
    const credentials = await pending;
    assert.equal(credentials.userId, "device-user@example.test");
    assert.equal(credentials.deviceId, "device_123");
    assert.equal(credentials.deviceName, "devbox");
    assert.match(credentials.accessToken, /^local_dev_access_/);
  } finally {
    await server.close();
  }
});

test("Bridge App relay foundation enforces device status, Project Grants, and command scopes", () => {
  const grant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["execute.start", "remoteRelay.access"]
  };
  const artifactGrant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["artifactAction.run", "hostAlias.expose", "remoteRelay.access"]
  };
  const fullArtifactGrant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"]
  };
  const device = {
    deviceId: "device_123",
    deviceName: "devbox",
    userId: "user_123",
    registeredAt: new Date().toISOString(),
    status: "online" as const
  };

  assert.deepEqual(scopesForRelayCommand("execute.start"), ["execute.start", "remoteRelay.access"]);
  assert.deepEqual(scopesForRelayCommand("bridge.status"), []);
  assert.deepEqual(scopesForRelayCommand("provider.inventory"), []);
  assert.deepEqual(scopesForRelayCommand("modelAlias.validate"), []);
  assert.deepEqual(scopesForRelayCommand("modelAlias.resolve"), []);
  assert.deepEqual(scopesForRelayCommand("roadmap.board"), ["remoteRelay.access"]);
  assert.deepEqual(scopesForRelayCommand("artifactAction.runs"), ["env.read", "hostAlias.expose", "remoteRelay.access"]);
  assert.deepEqual(scopesForRelayCommand("artifactAction.start"), ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"]);
  assert.equal(evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "execute.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  }).ok, true);
  assert.deepEqual(evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "execute.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [{ ...grant, active: false }]
  }), {
    ok: false,
    reason: "project_grant_denied",
    message: "Project Grant is required for this Relay command."
  });
  assert.equal(evaluateRelayCommand({
    device: { ...device, status: "offline" },
    command: { deviceId: device.deviceId, command: "execute.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  }).ok, false);
  assert.deepEqual(evaluateRelayCommand({
    device: { ...device, remoteAccess: "disabled" },
    command: { deviceId: device.deviceId, command: "bridge.status" },
    projectGrants: []
  }), {
    ok: false,
    reason: "device_offline",
    message: "Remote Bridge is disabled for this device."
  });
  const denied = evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "artifactAction.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [grant]
  });
  assert.deepEqual(denied, {
    ok: false,
    reason: "command_scope_denied",
    message: "Project Grant does not allow artifactAction.run."
  });
  const missingEnv = evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "artifactAction.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [artifactGrant]
  });
  assert.deepEqual(missingEnv, {
    ok: false,
    reason: "command_scope_denied",
    message: "Project Grant does not allow env.read."
  });
  const narrowedScopes = evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "artifactAction.start", projectPath: "/tmp/hunsu-project", requestedScopes: ["remoteRelay.access"] },
    projectGrants: [grant]
  });
  assert.deepEqual(narrowedScopes, {
    ok: false,
    reason: "command_scope_denied",
    message: "Project Grant does not allow artifactAction.run."
  });
  assert.deepEqual(evaluateRelayCommand({
    device,
    command: { deviceId: device.deviceId, command: "artifactAction.start", projectPath: "/tmp/hunsu-project" },
    projectGrants: [fullArtifactGrant]
  }), {
    ok: true,
    scopes: ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"]
  });
  assert.deepEqual(relayHttpRequestForCommand({ deviceId: device.deviceId, command: "roadmap.open", projectPath: "/tmp/hunsu-project" }), {
    method: "POST",
    path: "/api/roadmaps/open",
    body: { path: "/tmp/hunsu-project" }
  });
  assert.deepEqual(relayHttpRequestForCommand({ deviceId: device.deviceId, command: "bridge.status" }), {
    method: "GET",
    path: "/api/bridge/status"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "provider.inventory",
    payload: { backendId: `remote:${device.deviceId}` }
  }), {
    method: "GET",
    path: "/api/providers/inventory?backendId=local"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "modelAlias.resolve",
    payload: {
      backendId: `remote:${device.deviceId}`,
      modelSelection: { kind: "alias", aliasId: "PrimaryModel" }
    }
  }), {
    method: "POST",
    path: "/api/model-aliases/resolve",
    body: {
      backendId: "local",
      connectionMode: "local",
      modelSelection: { kind: "alias", aliasId: "PrimaryModel" }
    }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "roadmap.board",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/board"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "execute.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", selectedDestinationIds: ["destination_001"] }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/executes/start",
    body: { roadmapId: "roadmap_123", selectedDestinationIds: ["destination_001"] }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "execute.start",
    projectPath: "/tmp/hunsu-project",
    payload: {
      roadmapId: "roadmap_123",
      backendId: `remote:${device.deviceId}`,
      connectionMode: "remote",
      workspace: { workspaceId: "roadmap_123", backendId: `remote:${device.deviceId}`, connectionMode: "remote" }
    }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/executes/start",
    body: {
      roadmapId: "roadmap_123",
      backendId: "local",
      connectionMode: "local",
      workspace: { workspaceId: "roadmap_123", backendId: "local", connectionMode: "local" }
    }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "artifactAction.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", actionId: "host-web", commit: "HEAD" }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/artifact-actions/host-web/runs",
    body: { roadmapId: "roadmap_123", actionId: "host-web", commit: "HEAD" }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "artifactAction.stop",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", runId: "run_123" }
  }), {
    method: "POST",
    path: "/api/roadmaps/roadmap_123/action-runs/run_123/stop",
    body: { roadmapId: "roadmap_123", runId: "run_123" }
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "moveFile.blob",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", moveId: "M0001", path: "src/App.tsx" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/moves/M0001/files/blob?path=src%2FApp.tsx"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "hunsuDraft.diffArtifact.get",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", draftSessionId: "draft_1", diffArtifactId: "diff_1" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/hunsu/drafts/draft_1/diff-artifacts/diff_1"
  });
  assert.deepEqual(relayHttpRequestForCommand({
    deviceId: device.deviceId,
    command: "agentSession.events",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123", sessionId: "agent_1" }
  }), {
    method: "GET",
    path: "/api/roadmaps/roadmap_123/agent-sessions/agent_1/events",
    stream: true
  });
});

test("Bridge App Relay inventory transport preserves the selected remote backend identity", async () => {
  const deviceId = "device_inventory";
  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    command: {
      deviceId,
      command: "provider.inventory",
      payload: { backendId: `remote:${deviceId}` }
    },
    fetchImpl: async url => {
      assert.equal(String(url), "http://127.0.0.1:19689/api/providers/inventory?backendId=local");
      return new Response(JSON.stringify({
        ok: true,
        value: { backendId: "local", providers: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    body: {
      ok: true,
      value: { backendId: `remote:${deviceId}`, providers: [] }
    }
  });
});

test("Bridge App Remote Access registry records offline and online device transitions", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-remote-access-state-"));
  const registry = new FileRelayRegistry(join(root, "relay.json"));
  try {
    const registered = registry.registerDevice({
      deviceId: "device_state",
      deviceName: "state-devbox",
      userId: "user_state",
      bridgeVersion: "0.1.2",
      protocolVersion: "local-bridge-v1"
    });
    assert.equal(registered.status, "offline");
    assert.equal(registered.remoteAccess, "enabled");
    assert.equal(registry.updateDeviceStatus("device_state", "online")?.status, "online");
    assert.equal(registry.listDevices("user_state")[0]?.status, "online");
    assert.equal(registry.updateDeviceStatus("device_state", "offline")?.status, "offline");
    assert.equal(registry.listDevices("user_state")[0]?.status, "offline");
    assert.equal(registry.updateDeviceStatus("device_state", "offline", "disabled")?.remoteAccess, "disabled");
    assert.deepEqual(registry.listDevices("user_state"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App validates remote roadmapId against the granted local project path before forwarding", async () => {
  const calls: string[] = [];
  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeControlToken: "token",
    command: {
      deviceId: "device_123",
      command: "execute.start",
      projectPath: "/tmp/granted-project",
      payload: { roadmapId: "roadmap_other", selectedDestinationIds: ["destination_001"] }
    },
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      assert.equal(String(url), "http://127.0.0.1:19689/api/roadmaps/recent");
      return new Response(JSON.stringify({
        roadmaps: [{
          roadmapId: "roadmap_other",
          repositoryPath: "/tmp/different-project",
          displayName: "Different Project"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(calls, ["GET /api/roadmaps/recent"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.error, /does not belong/);
  }
});

test("Bridge App rejects Relay project payloads that override the granted path", async () => {
  const request = relayHttpRequestForCommand({
    deviceId: "device_123",
    command: "roadmap.open",
    projectPath: "/tmp/granted-project",
    payload: { path: "/tmp/other-project", title: "Granted" }
  });
  assert.deepEqual(request, {
    method: "POST",
    path: "/api/roadmaps/open",
    body: { title: "Granted", path: "/tmp/granted-project" }
  });

  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    command: {
      deviceId: "device_123",
      command: "roadmap.open",
      projectPath: "/tmp/granted-project",
      payload: { path: "/tmp/other-project", title: "Other" }
    },
    fetchImpl: async () => {
      assert.fail("Mismatched Relay project payload should be rejected before Bridge forwarding.");
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.error, /payload path/);
  }

  const cwdResult = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    command: {
      deviceId: "device_123",
      command: "roadmap.create",
      projectPath: "/tmp/granted-project",
      payload: { cwd: "/tmp/other-project", title: "Other" }
    },
    fetchImpl: async () => {
      assert.fail("Mismatched Relay project cwd should be rejected before Bridge forwarding.");
    }
  });

  assert.equal(cwdResult.ok, false);
  if (!cwdResult.ok) {
    assert.equal(cwdResult.status, 403);
    assert.match(cwdResult.error, /payload cwd/);
  }
});

test("Bridge App allows Relay move file payload paths as repo-relative file paths", async () => {
  const calls: string[] = [];
  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeControlToken: "token",
    command: {
      deviceId: "device_123",
      command: "moveFile.blob",
      projectPath: "/tmp/granted-project",
      payload: { roadmapId: "roadmap_123", moveId: "M0001", path: "src/App.tsx" }
    },
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(String(url));
      calls.push(`${init?.method ?? "GET"} ${requestUrl.pathname}${requestUrl.search}`);
      if (requestUrl.pathname === "/api/roadmaps/recent") {
        return new Response(JSON.stringify({
          roadmaps: [{
            roadmapId: "roadmap_123",
            repositoryPath: "/tmp/granted-project",
            displayName: "Granted Project"
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(requestUrl.pathname, "/api/roadmaps/roadmap_123/moves/M0001/files/blob");
      assert.equal(requestUrl.searchParams.get("path"), "src/App.tsx");
      return new Response(JSON.stringify({
        blob: {
          kind: "text",
          moveId: "M0001",
          commit: "abc123",
          path: "src/App.tsx",
          text: "export {};",
          size: 10
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(calls, [
    "GET /api/roadmaps/recent",
    "GET /api/roadmaps/roadmap_123/moves/M0001/files/blob?path=src%2FApp.tsx"
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.body as { blob?: { path?: string } }).blob?.path, "src/App.tsx");
  }
});

test("Bridge App validates remote registry removal roadmapId against the granted project path", async () => {
  const calls: string[] = [];
  const result = await forwardRelayCommand({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeControlToken: "token",
    command: {
      deviceId: "device_123",
      command: "roadmap.registry.remove",
      projectPath: "/tmp/granted-project",
      payload: { roadmapId: "roadmap_other" }
    },
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      assert.equal(String(url), "http://127.0.0.1:19689/api/roadmaps/recent");
      return new Response(JSON.stringify({
        roadmaps: [{
          roadmapId: "roadmap_other",
          repositoryPath: "/tmp/different-project",
          displayName: "Different Project"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.deepEqual(calls, ["GET /api/roadmaps/recent"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.match(result.error, /does not belong/);
  }
});

test("Bridge App forwards remote event streams incrementally", async () => {
  const events: Array<{ event?: string; data?: string }> = [];
  const result = await forwardRelayCommandStream({
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeControlToken: "token",
    command: {
      deviceId: "device_123",
      command: "live.events",
      projectPath: "/tmp/hunsu-project",
      payload: { roadmapId: "roadmap_123" }
    },
    onEvent: event => events.push(event),
    fetchImpl: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/roadmaps/recent") {
        return new Response(JSON.stringify({
          roadmaps: [{
            roadmapId: "roadmap_123",
            repositoryPath: "/tmp/hunsu-project",
            displayName: "Hunsu Project"
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(pathname, "/api/roadmaps/roadmap_123/executes/events");
      assert.equal(init?.method, "GET");
      return new Response([
        ": connected",
        "",
        "event: runs.snapshot",
        "data: {\"type\":\"runs.snapshot\",\"runs\":[]}",
        "",
        "event: run.updated",
        "data: {\"type\":\"run.updated\",\"run\":{\"runId\":\"run_1\"}}",
        "",
        ""
      ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    { event: "runs.snapshot", data: "{\"type\":\"runs.snapshot\",\"runs\":[]}" },
    { event: "run.updated", data: "{\"type\":\"run.updated\",\"run\":{\"runId\":\"run_1\"}}" }
  ]);
});

test("Bridge App Relay forwarding redacts remote paths without Project Grant", async () => {
  const bridgeApiUrl = "http://127.0.0.1:19689";
  const grant: ProjectGrant = {
    path: "/tmp/granted-project",
    grantedAt: new Date().toISOString(),
    scopes: ["remoteRelay.access"]
  };
  const fetchImpl = async (url: URL | RequestInfo, _init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/connection/status") {
      return new Response(JSON.stringify({
        mode: "local",
        project: {
          roadmapId: "roadmap_secret",
          displayName: "Secret",
          repositoryPath: "/tmp/secret-project"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/bridge/status") {
      return new Response(JSON.stringify({
        provider: { providerId: "codex", label: "Codex", ready: true },
        connections: [{
          backendId: "local",
          mode: "local",
          label: "This computer",
          connection: { state: "connected" },
          workspaces: [
            { workspaceId: "roadmap_granted", displayName: "Granted", path: "/tmp/granted-project" },
            { workspaceId: "roadmap_secret", displayName: "Secret", path: "/tmp/secret-project" }
          ]
        }],
        workspaces: {
          active: [
            { workspaceId: "roadmap_granted", displayName: "Granted", path: "/tmp/granted-project" },
            { workspaceId: "roadmap_secret", displayName: "Secret", path: "/tmp/secret-project" }
          ],
          managed: [
            { workspaceId: "roadmap_granted", displayName: "Granted", path: "/tmp/granted-project" },
            { workspaceId: "roadmap_secret", displayName: "Secret", path: "/tmp/secret-project" }
          ]
        },
        account: { signedIn: true, userId: "user_123" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/roadmaps/recent") {
      return new Response(JSON.stringify({
        roadmaps: [
          { roadmapId: "roadmap_granted", displayName: "Granted", repositoryPath: "/tmp/granted-project", lastOpenedAt: "2026-07-08T00:00:00.000Z" },
          { roadmapId: "roadmap_secret", displayName: "Secret", repositoryPath: "/tmp/secret-project", lastOpenedAt: "2026-07-08T00:00:00.000Z" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `Unexpected path ${pathname}` }), { status: 500, headers: { "content-type": "application/json" } });
  };

  const status = await forwardRelayCommand({
    bridgeApiUrl,
    command: { deviceId: "device_123", command: "connection.status" },
    projectGrants: [grant],
    fetchImpl
  });
  assert.equal(status.ok, true);
  assert.equal(((status as { body: { project?: { repositoryPath?: string } } }).body.project ?? {}).repositoryPath, undefined);

  const bridgeStatus = await forwardRelayCommand({
    bridgeApiUrl,
    command: { deviceId: "device_123", command: "bridge.status" },
    projectGrants: [grant],
    fetchImpl
  });
  assert.equal(bridgeStatus.ok, true);
  const bridgeStatusBody = (bridgeStatus as { body: { workspaces: { active: Array<{ workspaceId: string; path?: string; pathRedacted?: boolean }> }; connections: Array<{ workspaces: Array<{ workspaceId: string; path?: string; pathRedacted?: boolean }> }> } }).body;
  assert.equal(bridgeStatusBody.workspaces.active.find(workspace => workspace.workspaceId === "roadmap_granted")?.path, "/tmp/granted-project");
  assert.equal(bridgeStatusBody.workspaces.active.find(workspace => workspace.workspaceId === "roadmap_secret")?.path, undefined);
  assert.equal(bridgeStatusBody.workspaces.active.find(workspace => workspace.workspaceId === "roadmap_secret")?.pathRedacted, true);
  assert.equal(bridgeStatusBody.connections[0]?.workspaces.find(workspace => workspace.workspaceId === "roadmap_secret")?.path, undefined);

  const registry = await forwardRelayCommand({
    bridgeApiUrl,
    command: { deviceId: "device_123", command: "roadmap.registry.list" },
    projectGrants: [grant],
    fetchImpl
  });
  assert.equal(registry.ok, true);
  const roadmaps = (registry as { body: { roadmaps: Array<{ roadmapId: string; repositoryPath: string }> } }).body.roadmaps;
  assert.deepEqual(roadmaps.map(roadmap => roadmap.roadmapId), ["roadmap_granted"]);
  assert.equal(roadmaps[0]?.repositoryPath, "/tmp/granted-project");
});

test("Bridge App Relay command mappings target implemented Bridge routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-relay-route-map-"));
  const projectPath = join(root, "project");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const state = createStudioState();
  const opened = createStudioRoadmap({ path: projectPath, title: "Relay Route Map" }, state, { persist: true, roadmapRegistryPath });
  const server = createStudioServer({
    cwd: projectPath,
    state,
    persist: true,
    roadmapRegistryPath,
    runner: bridgeDesktopRouteTestRunner()
  });

  try {
    for (const command of relayMappingCommandCases(opened.roadmap.roadmapId, projectPath)) {
      const request = relayHttpRequestForCommand(command);
      assert.ok(request, `${command.command} should map to a Bridge API request`);
      assert.match(request.path, /^\/(health|api)/, `${command.command} path should be a Bridge API path`);
      const response = await requestBridgeServerRoute(server, request);
      assert.equal(isUnhandledBridgeRoute(response), false, `${command.command} mapped to an unimplemented Bridge route: ${request.method} ${request.path}`);
    }
  } finally {
    try {
      server.close();
    } catch (_error) {
      // The in-memory route harness does not listen on a socket.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function relayMappingCommandCases(roadmapId: string, projectPath: string): RelayCommand[] {
  return [
    { deviceId: "device_123", command: "health" },
    { deviceId: "device_123", command: "bridge.status" },
    { deviceId: "device_123", command: "connection.status" },
    { deviceId: "device_123", command: "roadmap.registry.list" },
    { deviceId: "device_123", command: "roadmap.open", projectPath },
    { deviceId: "device_123", command: "roadmap.port.inspect", projectPath },
    { deviceId: "device_123", command: "roadmap.port.apply", projectPath, payload: { goal: "Route map smoke" } },
    { deviceId: "device_123", command: "roadmap.create", projectPath },
    { deviceId: "device_123", command: "roadmap.board", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "roadmap.worktree", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "roadmap.skills", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "roadmap.commands", projectPath, payload: { roadmapId, commands: [] } },
    { deviceId: "device_123", command: "execute.start", projectPath, payload: { roadmapId, selectedDestinationIds: ["destination_missing"] } },
    { deviceId: "device_123", command: "execute.pause", projectPath, payload: { roadmapId, runId: "run_missing" } },
    { deviceId: "device_123", command: "execute.resume", projectPath, payload: { roadmapId, runId: "run_missing" } },
    { deviceId: "device_123", command: "execute.stop", projectPath, payload: { roadmapId, runId: "run_missing" } },
    { deviceId: "device_123", command: "execute.completeMove", projectPath, payload: { roadmapId, runId: "run_missing" } },
    { deviceId: "device_123", command: "execute.status", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "artifactAction.list", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "artifactAction.runs", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "artifactAction.start", projectPath, payload: { roadmapId, actionId: "host-web" } },
    { deviceId: "device_123", command: "artifactAction.stop", projectPath, payload: { roadmapId, runId: "action_run_missing" } },
    { deviceId: "device_123", command: "moveFile.tree", projectPath, payload: { roadmapId, moveId: "M0001", path: "src" } },
    { deviceId: "device_123", command: "moveFile.blob", projectPath, payload: { roadmapId, moveId: "M0001", path: "src/App.tsx" } },
    { deviceId: "device_123", command: "moveFile.diff", projectPath, payload: { roadmapId, moveId: "M0001" } },
    { deviceId: "device_123", command: "hunsuDraft.list", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "hunsuDraft.start", projectPath, payload: { roadmapId, sourceNodeId: "node_missing", sourceLineId: "line_missing" } },
    { deviceId: "device_123", command: "hunsuDraft.get", projectPath, payload: { roadmapId, draftSessionId: "draft_123" } },
    { deviceId: "device_123", command: "hunsuDraft.message", projectPath, payload: { roadmapId, draftSessionId: "draft_123", message: "hello" } },
    { deviceId: "device_123", command: "hunsuDraft.diffArtifact.create", projectPath, payload: { roadmapId, draftSessionId: "draft_123" } },
    { deviceId: "device_123", command: "hunsuDraft.diffArtifact.get", projectPath, payload: { roadmapId, draftSessionId: "draft_123", diffArtifactId: "diff_123" } },
    { deviceId: "device_123", command: "hunsuDraft.approve", projectPath, payload: { roadmapId, draftSessionId: "draft_123", diffArtifactId: "diff_123" } },
    { deviceId: "device_123", command: "hunsuDraft.discard", projectPath, payload: { roadmapId, draftSessionId: "draft_123" } },
    { deviceId: "device_123", command: "line.accept", projectPath, payload: { roadmapId, lineId: "line_missing" } },
    { deviceId: "device_123", command: "line.reject", projectPath, payload: { roadmapId, lineId: "line_missing" } },
    { deviceId: "device_123", command: "agentSession.list", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "agentSession.get", projectPath, payload: { roadmapId, sessionId: "agent_123" } },
    { deviceId: "device_123", command: "agentSession.events", projectPath, payload: { roadmapId, sessionId: "agent_123" } },
    { deviceId: "device_123", command: "live.events", projectPath, payload: { roadmapId } },
    { deviceId: "device_123", command: "roadmap.registry.remove", projectPath, payload: { roadmapId } }
  ];
}

function bridgeDesktopRouteTestRunner(): any {
  const fail = async () => {
    throw new Error("Route mapping test runner should not execute provider work.");
  };
  return {
    providerStatus: async () => ({ backend: "test", available: true }),
    runTeamPlanning: fail,
    runMemberPath: fail,
    runMoveFinalizer: fail,
    runHunsuDraftTurn: fail,
    resumeRun: fail,
    pauseRun: fail,
    stopRun: fail,
    events: async function* () {}
  };
}

async function requestBridgeServerRoute(
  server: ReturnType<typeof createStudioServer>,
  requestSpec: RelayHttpRequest
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const listener = server.listeners("request")[0] as ((request: any, response: any) => void) | undefined;
  assert.ok(listener);
  return await new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Bridge route ${requestSpec.method} ${requestSpec.path}`)), 10_000);
    const bodyText = requestSpec.body === undefined ? "" : JSON.stringify(requestSpec.body);
    const listeners = new Map<string, Array<() => void>>();
    let settled = false;
    const settle = (value: { status: number; body: any; headers: Record<string, string> }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const emit = (event: string) => {
      for (const callback of listeners.get(event) ?? []) {
        callback();
      }
    };
    const request = {
      method: requestSpec.method,
      url: requestSpec.path,
      headers: {},
      on(event: string, callback: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
        return request;
      },
      async *[Symbol.asyncIterator]() {
        if (bodyText) {
          yield Buffer.from(bodyText);
        }
      }
    };
    const response = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      destroyed: false,
      writeHead(status: number, headers?: Record<string, string>) {
        this.statusCode = status;
        this.headers = lowerCaseHeaders(headers ?? {});
      },
      flushHeaders() {},
      write(chunk: string | Buffer) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        if (this.headers["content-type"]?.includes("text/event-stream")) {
          this.destroyed = true;
          emit("close");
          settle({ status: this.statusCode, body: text, headers: this.headers });
        }
        return true;
      },
      end(body = "") {
        const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
        const parsedBody = text ? JSON.parse(text) : undefined;
        settle({ status: this.statusCode, body: parsedBody, headers: this.headers });
      }
    };
    listener(request, response);
  });
}

function isUnhandledBridgeRoute(response: { status: number; body: any }): boolean {
  return response.status === 404 && response.body?.error === "Not found";
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

test("Local dev Relay service authenticates sessions, lists devices, and routes typed commands", async () => {
  const relay = new LocalDevRelayService();
  relay.registerSession({ accessToken: "web-token", userId: "user_123" });
  const device = relay.registerDevice("web-token", {
    deviceId: "device_123",
    deviceName: "devbox",
    userId: "user_123",
    bridgeVersion: "0.1.2",
    protocolVersion: "local-bridge-v1"
  });
  assert.equal(device.status, "offline");
  assert.equal(relay.listDevices("web-token")[0]?.deviceName, "devbox");
  relay.connectDevice("web-token", "device_123", async envelope => {
    assert.equal(envelope.userId, "user_123");
    assert.equal(envelope.command.command, "execute.start");
    return { ok: true, status: 202, body: { accepted: true } };
  });
  assert.deepEqual(await relay.routeCommand("web-token", {
    deviceId: "device_123",
    command: "execute.start",
    projectPath: "/tmp/hunsu-project",
    payload: { roadmapId: "roadmap_123" }
  }), { ok: true, status: 202, body: { accepted: true } });
  relay.markDeviceOffline("web-token", "device_123");
  const offline = await relay.routeCommand("web-token", {
    deviceId: "device_123",
    command: "execute.start",
    projectPath: "/tmp/hunsu-project"
  });
  assert.equal(offline.ok, false);
  if (!offline.ok && "reason" in offline) assert.equal(offline.reason, "device_offline");
});

test("Bridge App outbound Relay client registers devices and forwards only granted typed commands", async () => {
  const sent: unknown[] = [];
  const forwardedRequests: Array<{ path: string; method?: string; token?: string }> = [];
  let onOpen: (() => void) | undefined;
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const socket = {
    send(message: string) {
      sent.push(JSON.parse(message));
    },
    close() {},
    addEventListener(event: "open" | "message" | "close" | "error", listener: (payload: unknown) => void) {
      if (event === "open") onOpen = listener as () => void;
      if (event === "message") onMessage = listener as (payload: { data: unknown }) => void;
    }
  };
  const grant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["remoteRelay.access"]
  };
  const remoteSnapshotAt = new Date().toISOString();
  const client = new RelayOutboundClient({
    relayUrl: "wss://relay.example.test/device",
    device: {
      deviceId: "device_123",
      deviceName: "devbox",
      userId: "user_123",
      registeredAt: new Date().toISOString(),
      status: "online",
      provider: { providerId: "codex", kind: "codex", label: "Codex", connectionKind: "local_cli", installed: true, configured: true, authenticated: true, ready: true, auth: { kind: "chatgpt_oauth", state: "authenticated" }, capabilities: { canExecute: true, canEditFiles: true, canRunShell: true, supportsWorktree: true, supportsEventStream: true, supportsUsage: true, supportsSubscriptionAuth: true, supportsDeviceAuth: true, supportsApiKeyAuth: false, supportsRemoteRelay: true, supportsAcp: false }, modelInventory: { state: "available", models: [] }, recommendedAction: "none" },
      workspaces: [{
        workspaceId: "roadmap_remote",
        roadmapId: "roadmap_remote",
        displayName: "Remote Project",
        pathRedacted: true,
        lifecycle: "active",
        health: "ok",
        backendId: "local",
        connectionMode: "local",
        provider: { providerId: "codex", label: "Codex", readyForExecute: true },
        actions: ["open_studio", "deactivate"]
      }],
      lastSnapshotAt: remoteSnapshotAt
    },
    projectGrants: [grant],
    bridgeApiUrl: "http://127.0.0.1:19689",
    bridgeControlToken: "token",
    websocketFactory: () => socket,
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(String(url));
      const headers = init?.headers as Record<string, string> | undefined;
      forwardedRequests.push({ path: requestUrl.pathname, method: init?.method, token: headers?.["x-hunsu-bridge-control-token"] });
      if (requestUrl.pathname === "/api/bridge/status") {
        assert.equal(init?.method, "GET");
        assert.equal(headers?.["x-hunsu-bridge-control-token"], "token");
        return new Response(JSON.stringify({ provider: { providerId: "codex" }, connections: [], workspaces: { active: [], managed: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      assert.equal(requestUrl.pathname, "/api/roadmaps/open");
      assert.equal(init?.method, "POST");
      assert.equal(headers?.["x-hunsu-bridge-control-token"], "token");
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    }
  });

  try {
    client.start();
    onOpen?.();
    assert.equal((sent[0] as { type: string }).type, "device.register");
    assert.equal((sent[0] as { device: { provider?: { providerId?: string } } }).device.provider?.providerId, "codex");
    assert.equal((sent[0] as { device: { workspaces?: Array<{ workspaceId: string }> } }).device.workspaces?.[0]?.workspaceId, "roadmap_remote");
    assert.deepEqual((sent[0] as { workspaces?: Array<{ workspaceId: string }> }).workspaces?.map(workspace => workspace.workspaceId), ["roadmap_remote"]);
    assert.equal((sent[0] as { lastSnapshotAt?: string }).lastSnapshotAt, remoteSnapshotAt);
    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_status",
      userId: "user_123",
      command: { deviceId: "device_123", command: "bridge.status" }
    }) });
    await delay(0);
    assert.deepEqual(sent.at(-1), {
      type: "command.result",
      commandId: "command_status",
      result: {
        ok: true,
        status: 200,
        body: { provider: { providerId: "codex" }, connections: [], workspaces: { active: [], managed: [] } }
      }
    });
    assert.deepEqual(forwardedRequests[0], { path: "/api/bridge/status", method: "GET", token: "token" });

    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_1",
      userId: "user_123",
      command: { deviceId: "device_123", command: "roadmap.open", projectPath: "/tmp/hunsu-project" }
    }) });
    await delay(0);
    assert.deepEqual(sent.at(-1), {
      type: "command.result",
      commandId: "command_1",
      result: { ok: true, status: 202, body: { ok: true } }
    });
    assert.deepEqual(forwardedRequests[1], { path: "/api/roadmaps/open", method: "POST", token: "token" });

    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_2",
      userId: "user_123",
      command: { deviceId: "device_123", command: "execute.start", projectPath: "/tmp/hunsu-project" }
    }) });
    await delay(0);
    assert.equal((sent.at(-1) as { result: { ok: boolean; reason?: string } }).result.ok, false);
    assert.equal((sent.at(-1) as { result: { ok: boolean; reason?: string } }).result.reason, "command_scope_denied");
  } finally {
    client.stop();
  }
});

test("Bridge App outbound Relay client refreshes active Project Grants after revocation", async () => {
  const sent: unknown[] = [];
  let onOpen: (() => void) | undefined;
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const socket = {
    send(message: string) {
      sent.push(JSON.parse(message));
    },
    close() {},
    addEventListener(event: "open" | "message" | "close" | "error", listener: (payload: unknown) => void) {
      if (event === "open") onOpen = listener as () => void;
      if (event === "message") onMessage = listener as (payload: { data: unknown }) => void;
    }
  };
  const grant: ProjectGrant = {
    path: "/tmp/hunsu-project",
    grantedAt: new Date().toISOString(),
    scopes: ["execute.start", "remoteRelay.access"]
  };
  const client = new RelayOutboundClient({
    relayUrl: "wss://relay.example.test/device",
    device: {
      deviceId: "device_123",
      deviceName: "devbox",
      userId: "user_123",
      registeredAt: new Date().toISOString(),
      status: "online"
    },
    projectGrants: [grant],
    bridgeApiUrl: "http://127.0.0.1:19689",
    websocketFactory: () => socket,
    fetchImpl: async () => {
      throw new Error("Revoked Relay command should not be forwarded to Bridge.");
    }
  });

  try {
    client.start();
    onOpen?.();
    assert.equal((sent[0] as { type: string }).type, "device.register");
    assert.deepEqual((sent[0] as { projectGrants: ProjectGrant[] }).projectGrants, [grant]);

    client.updateProjectGrants([]);
    const refresh = sent.at(-1) as { type?: string; projectGrants?: ProjectGrant[] };
    assert.equal(refresh.type, "device.register");
    assert.deepEqual(refresh.projectGrants, []);

    onMessage?.({ data: JSON.stringify({
      type: "command",
      commandId: "command_revoked",
      userId: "user_123",
      command: { deviceId: "device_123", command: "execute.start", projectPath: "/tmp/hunsu-project" }
    }) });
    await delay(0);
    assert.deepEqual(sent.at(-1), {
      type: "command.result",
      commandId: "command_revoked",
      result: {
        ok: false,
        reason: "project_grant_denied",
        message: "Project Grant is required for this Relay command."
      }
    });
  } finally {
    client.stop();
  }
});

test("Bridge App outbound Relay client heartbeats and reconnects with backoff", async () => {
  type Listener = (event?: unknown) => void;
  const sockets: Array<{
    sent: unknown[];
    closed: boolean;
    send(message: string): void;
    close(): void;
    addEventListener(event: "open" | "message" | "close" | "error", listener: Listener): void;
    emit(event: "open" | "message" | "close" | "error", payload?: unknown): void;
  }> = [];

  function createSocket() {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      sent: [] as unknown[],
      closed: false,
      send(message: string) {
        socket.sent.push(JSON.parse(message));
      },
      close() {
        socket.closed = true;
      },
      addEventListener(event: "open" | "message" | "close" | "error", listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit(event: "open" | "message" | "close" | "error", payload?: unknown) {
        for (const listener of listeners.get(event) ?? []) {
          listener(payload);
        }
      }
    };
    sockets.push(socket);
    return socket;
  }

  const client = new RelayOutboundClient({
    relayUrl: "wss://relay.example.test/device",
    device: {
      deviceId: "device_heartbeat",
      deviceName: "devbox",
      userId: "user_123",
      registeredAt: new Date().toISOString(),
      status: "online"
    },
    projectGrants: [],
    websocketFactory: createSocket,
    heartbeatIntervalMs: 10,
    reconnectInitialDelayMs: 15,
    reconnectMaxDelayMs: 15
  });

  try {
    client.start();
    assert.equal(sockets.length, 1);
    sockets[0]?.emit("open");
    assert.equal((sockets[0]?.sent[0] as { type?: string } | undefined)?.type, "device.register");
    assert.equal((sockets[0]?.sent[1] as { type?: string } | undefined)?.type, "device.heartbeat");
    await waitFor(() => (sockets[0]?.sent.filter(message => (message as { type?: string }).type === "device.heartbeat").length ?? 0) >= 2);

    sockets[0]?.emit("close");
    assert.equal(client.status().status, "closed");
    await waitFor(() => sockets.length === 2);
    assert.equal(client.status().status, "connecting");
    sockets[1]?.emit("open");
    assert.equal(client.status().status, "connected");
    assert.equal((sockets[1]?.sent[0] as { type?: string } | undefined)?.type, "device.register");

    client.stop();
    const socketCountAfterStop = sockets.length;
    sockets[1]?.emit("close");
    await delay(25);
    assert.equal(sockets.length, socketCountAfterStop);
    assert.equal(client.status().status, "closed");
  } finally {
    client.stop();
  }
});

const CURRENT_SIDECAR_TARGET = new Map([
  ["darwin/x64", "x86_64-apple-darwin"],
  ["darwin/arm64", "aarch64-apple-darwin"],
  ["linux/x64", "x86_64-unknown-linux-gnu"],
  ["linux/arm64", "aarch64-unknown-linux-gnu"],
  ["win32/x64", "x86_64-pc-windows-msvc"],
  ["win32/arm64", "aarch64-pc-windows-msvc"]
]).get(`${process.platform}/${process.arch}`);
const BUILT_CURRENT_PLATFORM_SIDECAR = join(
  process.cwd(),
  "apps/bridge-desktop/dist",
  CURRENT_SIDECAR_TARGET
    ? `hunsu-bridge-sidecar-${CURRENT_SIDECAR_TARGET}${process.platform === "win32" ? ".exe" : ""}`
    : "unsupported-sidecar-target"
);
const SIDECAR_DIST_DIR = join(process.cwd(), "apps/bridge-desktop/dist");
const SIDECAR_DIST_MUTATED_FILES = [
  "sidecar-manifest.json",
  "hunsu-bridge-sidecar",
  "hunsu-bridge-sidecar.exe",
  "hunsu-bridge-sidecar-x86_64-apple-darwin",
  "hunsu-bridge-sidecar-aarch64-apple-darwin",
  "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-aarch64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe",
  "hunsu-bridge-sidecar-aarch64-pc-windows-msvc.exe"
];

test("built current-platform Bridge sidecar passes the bounded smoke command", {
  skip: existsSync(BUILT_CURRENT_PLATFORM_SIDECAR) ? false : "Build @hunsu/bridge-desktop to generate the current-platform sidecar."
}, () => {
  assert.ok(CURRENT_SIDECAR_TARGET);
  const smoke = spawnSync(process.execPath, [
    "--conditions=development",
    "apps/bridge-desktop/scripts/smoke-native-sidecar.mjs",
    "--sidecar",
    BUILT_CURRENT_PLATFORM_SIDECAR,
    "--target",
    CURRENT_SIDECAR_TARGET,
    "--timeout-ms",
    "10000"
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
  assert.match(smoke.stdout, /Local Bridge: Not Running/);
  assert.match(smoke.stdout, /\[sidecar-smoke\] completed in/);
});

test("Bridge desktop filtered artifact report command resolves package-root defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-artifact-report-test-"));
  const workspaceRoot = join(root, "workspace");
  const packageRoot = join(workspaceRoot, "apps/bridge-desktop");
  const bundleDir = join(packageRoot, "src-tauri/target/release/bundle");
  const distDir = join(packageRoot, "dist");
  const target = "x86_64-unknown-linux-gnu";
  const sidecarFile = `hunsu-bridge-sidecar-${target}`;
  try {
    mkdirSync(join(packageRoot, "scripts"), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    writeFileSync(
      join(packageRoot, "package.json"),
      readFileSync(join(process.cwd(), "apps/bridge-desktop/package.json"), "utf8"),
      "utf8"
    );
    writeFileSync(
      join(packageRoot, "scripts/report-artifact-sizes.mjs"),
      readFileSync(join(process.cwd(), "apps/bridge-desktop/scripts/report-artifact-sizes.mjs"), "utf8"),
      "utf8"
    );
    writeFileSync(join(bundleDir, "Hunsu Bridge.test-bundle"), "bundle", "utf8");
    writeFileSync(join(distDir, sidecarFile), "sidecar", "utf8");
    writeFileSync(join(distDir, "sidecar-manifest.json"), `${JSON.stringify({
      schema: "hunsu.bridge-sidecars.v1",
      target,
      artifacts: [{ target, file: sidecarFile, kind: "native-executable" }]
    }, null, 2)}\n`, "utf8");

    const reported = spawnSync("pnpm", [
      "--filter",
      "@hunsu/bridge-desktop",
      "artifacts:report-sizes",
      "--",
      "--target",
      target
    ], { cwd: workspaceRoot, encoding: "utf8" });

    assert.equal(reported.status, 0, `${reported.stdout}\n${reported.stderr}`);
    const report = JSON.parse(readFileSync(join(bundleDir, "artifact-size-report.json"), "utf8")) as {
      schema: string;
      directory: string;
      artifacts: Array<{ path: string }>;
      sidecars: Array<{ target: string; file: string }>;
    };
    assert.equal(report.schema, "hunsu.bridge-desktop-artifact-sizes.v2");
    assert.equal(report.directory, bundleDir);
    assert.deepEqual(report.artifacts.map(artifact => artifact.path), ["Hunsu Bridge.test-bundle"]);
    assert.deepEqual(report.sidecars, [{
      target,
      file: sidecarFile,
      sizeBytes: 7,
      sizeMiB: 0
    }]);
    assert.match(reported.stdout, new RegExp(`sidecar:${target}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App protocol plan and sidecar supervisor expose native desktop foundations", async () => {
  await delay(1_000);
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-test-"));
  const logPath = join(root, "sidecar.log");
  const sidecarDistSnapshot = snapshotSidecarDist();
  try {
    const plan = protocolRegistrationPlan("/tmp/hunsu-bridge-app");
    assert.equal(plan.protocol, "hunsu");
    const devProtocolPlan = protocolRegistrationPlan("/usr/bin/node", ["/opt/hunsu/bridge/main.js"]);
    assert.match(devProtocolPlan.notes.join("\n"), /\/usr\/bin\/node \/opt\/hunsu\/bridge\/main\.js %u/);
    const packagedInvocation = currentBridgeCommandInvocation({
      execPath: join(root, "hunsu-bridge-sidecar.exe"),
      argv: [join(root, "hunsu-bridge-sidecar.exe"), "daemon"],
      packaged: true,
      commandArgs: ["daemon"]
    });
    assert.equal(packagedInvocation.command, join(root, "hunsu-bridge-sidecar.exe"));
    assert.deepEqual(packagedInvocation.args, ["daemon"]);
    assert.equal(packagedInvocation.args.includes(join(root, "hunsu-bridge-sidecar.exe")), false);
    const packagedBasenameInvocation = currentBridgeCommandInvocation({
      execPath: join(root, "node.exe"),
      argv: [join(root, "node.exe"), join(root, "hunsu-bridge-sidecar.exe"), "daemon"],
      commandArgs: ["daemon"]
    });
    assert.equal(packagedBasenameInvocation.command, join(root, "node.exe"));
    assert.deepEqual(packagedBasenameInvocation.args, ["daemon"]);
    assert.equal(packagedBasenameInvocation.args.includes(join(root, "hunsu-bridge-sidecar.exe")), false);
    const devInvocation = currentBridgeCommandInvocation({
      execPath: process.execPath,
      argv: [process.execPath, "/opt/hunsu/bridge/main.js", "start"],
      packaged: false,
      commandArgs: ["daemon"]
    });
    assert.equal(devInvocation.command, process.execPath);
    assert.equal(devInvocation.args.includes("/opt/hunsu/bridge/main.js"), true);
    assert.equal(devInvocation.args.at(-1), "daemon");
    assert.equal(plan.supported, process.platform === "darwin" || process.platform === "win32" || process.platform === "linux");
    const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/tauri.conf.json"), "utf8")) as {
      app: { windows: Array<{ visible?: boolean }> };
      bundle: { externalBin?: string[]; resources?: string[]; targets?: string[] };
      plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
    };
    assert.equal(tauriConfig.app.windows[0]?.visible, false);
    assert.deepEqual(tauriConfig.bundle.targets, ["nsis"]);
    assert.deepEqual(tauriConfig.bundle.externalBin, ["../dist/hunsu-bridge-sidecar"]);
    assert.deepEqual(tauriConfig.bundle.resources, ["../dist/sidecar-manifest.json"]);
    assert.equal(tauriConfig.bundle.resources?.some(resource => resource.includes("hunsu-bridge-sidecar")), false);
    assert.deepEqual(tauriConfig.plugins?.["deep-link"]?.desktop?.schemes, ["hunsu"]);
    const cargoToml = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/Cargo.toml"), "utf8");
    assert.match(cargoToml, /tauri-plugin-deep-link = "2"/);
    assert.match(cargoToml, /tauri-plugin-single-instance = \{ version = "2", features = \["deep-link"\] \}/);
    const tauriSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/src/main.rs"), "utf8");
    const singleInstancePlugin = tauriSource.indexOf(".plugin(tauri_plugin_single_instance::init");
    const deepLinkPlugin = tauriSource.indexOf(".plugin(tauri_plugin_deep_link::init())");
    assert.equal(singleInstancePlugin >= 0, true);
    assert.equal(deepLinkPlugin > singleInstancePlugin, true);
    assert.match(tauriSource, /app\.deep_link\(\)\.on_open_url/);
    assert.match(tauriSource, /app\.deep_link\(\)\.get_current\(\)/);
    assert.match(tauriSource, /#\[cfg\(target_os = "linux"\)\][\s\S]*app\.deep_link\(\)\.register_all\(\)/);
    assert.match(tauriSource, /const BRIDGE_SIDECAR_NAME: &str = "hunsu-bridge-sidecar"/);
    assert.match(tauriSource, /\.sidecar\(BRIDGE_SIDECAR_NAME\)/);
    assert.match(tauriSource, /async fn bridge_snapshot/);
    assert.match(tauriSource, /tauri::async_runtime::spawn/);
    assert.doesNotMatch(tauriSource, /BaseDirectory::Resource|fn sidecar_path|std::process::Command|hunsu-bridge-sidecar\.exe/);
    assert.match(tauriSource, /Provider:/);
    assert.match(tauriSource, /Local:/);
    assert.match(tauriSource, /Remote:/);
    assert.match(tauriSource, /Workspaces:/);
    assert.match(tauriSource, /Open Hunsu Web/);
    assert.match(tauriSource, /Add Workspace/);
    assert.match(tauriSource, /MessageDialogButtons::OkCancel/);
    assert.match(tauriSource, /quit_background_preference/);
    assert.match(tauriSource, /status"\]\["quitBehavior"\]/);
    assert.doesNotMatch(tauriSource, /HUNSU_BRIDGE_QUIT_BACKGROUND/);
    const sidecarScript = readFileSync(join(process.cwd(), "apps/bridge-desktop/scripts/prepare-sidecars.mjs"), "utf8");
    const buildScript = readFileSync(join(process.cwd(), "apps/bridge-desktop/scripts/build-native-sidecars.mjs"), "utf8");
    const artifactWorkflow = readFileSync(join(process.cwd(), ".github/workflows/bridge-desktop-artifacts.yml"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.match(packageJson.scripts.build, /build-native-sidecars\.mjs/);
    assert.match(packageJson.scripts["sidecars:build"], /build-native-sidecars\.mjs/);
    assert.match(packageJson.scripts["artifacts:report-sizes"], /report-artifact-sizes\.mjs/);
    assert.match(packageJson.scripts["desktop:verify-windows-gui"], /verify-windows-gui-subsystem\.mjs/);
    assert.equal(packageJson.devDependencies.esbuild.length > 0, true);
    assert.equal(packageJson.devDependencies.postject.length > 0, true);
    assert.match(sidecarScript, /x86_64-apple-darwin/);
    assert.match(sidecarScript, /x86_64-pc-windows-msvc/);
    assert.match(sidecarScript, /extension: "\.exe"/);
    assert.doesNotMatch(sidecarScript, /exec node "\$SCRIPT_DIR\/main\.js"/);
    assert.doesNotMatch(sidecarScript, /hunsu-bridge-sidecar-x86_64-pc-windows-msvc\.cmd/);
    assert.match(buildScript, /NODE_SEA_BLOB/);
    assert.match(buildScript, /postject/);
    assert.match(buildScript, /SHASUMS256\.txt/);
    assert.match(buildScript, /darwin-x64/);
    assert.match(buildScript, /win-arm64/);
    assert.match(artifactWorkflow, /Windows ARM64/);
    assert.match(artifactWorkflow, /aarch64-pc-windows-msvc/);
    assert.match(artifactWorkflow, /hunsu-bridge-windows-arm64/);
    assert.match(artifactWorkflow, /windows-all/);
    assert.match(artifactWorkflow, /Linux x64/);
    assert.match(artifactWorkflow, /aarch64-unknown-linux-gnu/);
    const matrixTargets = (selection: string): string[] => {
      const escapedSelection = selection.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(`\\n\\s*${escapedSelection}\\)\\n\\s*matrix='([^']+)'`, "u").exec(artifactWorkflow);
      assert.ok(match, `Missing desktop matrix selection ${selection}`);
      return (JSON.parse(match[1] ?? "") as { include: Array<{ rust_target: string }> })
        .include
        .map(entry => entry.rust_target);
    };
    assert.deepEqual(matrixTargets("windows"), ["x86_64-pc-windows-msvc"]);
    assert.deepEqual(matrixTargets("windows-arm64"), ["aarch64-pc-windows-msvc"]);
    assert.deepEqual(matrixTargets("windows-all"), [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc"
    ]);
    assert.deepEqual(matrixTargets("macos-arm64"), ["aarch64-apple-darwin"]);
    assert.deepEqual(matrixTargets("macos-intel"), ["x86_64-apple-darwin"]);
    assert.deepEqual(matrixTargets("linux"), ["x86_64-unknown-linux-gnu"]);
    assert.deepEqual(matrixTargets("linux-arm64"), ["aarch64-unknown-linux-gnu"]);
    assert.deepEqual(matrixTargets("all"), [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu"
    ]);
    assert.match(artifactWorkflow, /HUNSU_BRIDGE_SIDECAR_TARGET/);
    assert.match(artifactWorkflow, /if: startsWith\(matrix\.platform, 'windows'\)/);
    assert.match(artifactWorkflow, /desktop:verify-windows-gui/);
    assert.match(artifactWorkflow, /group: bridge-desktop-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.platform \}\}/);
    assert.match(artifactWorkflow, /cancel-in-progress: true/);
    assert.match(artifactWorkflow, /timeout-minutes: 60/);
    assert.match(artifactWorkflow, /uses: pnpm\/action-setup@v4/);
    assert.match(artifactWorkflow, /cache: pnpm/);
    assert.match(artifactWorkflow, /cache-dependency-path: pnpm-lock\.yaml/);
    assert.match(artifactWorkflow, /uses: Swatinem\/rust-cache@v2/);
    assert.match(artifactWorkflow, /workspaces: apps\/bridge-desktop\/src-tauri -> target/);
    assert.match(artifactWorkflow, /key: \$\{\{ matrix\.rust_target \}\}/);
    assert.match(artifactWorkflow, /cache-on-failure: true/);
    assert.match(artifactWorkflow, /path: apps\/bridge-desktop\/\.sidecar-cache/);
    assert.match(artifactWorkflow, /bridge-sidecar-node-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.rust_target \}\}-22\.22\.0/);
    assert.equal(
      artifactWorkflow.indexOf("uses: pnpm/action-setup@v4")
        < artifactWorkflow.indexOf("uses: actions/setup-node@v4"),
      true
    );
    assert.match(artifactWorkflow, /Verify and smoke-test native sidecar/);
    assert.match(artifactWorkflow, /node --conditions=development apps\/bridge-desktop\/scripts\/smoke-native-sidecar\.mjs/);
    assert.match(artifactWorkflow, /--timeout-ms 60000/);
    assert.doesNotMatch(artifactWorkflow, /spawnSync\(|node --input-type=module|<<'NODE'/);
    assert.match(artifactWorkflow, /codesign --verify --strict --verbose=2 "\$\{SIDECAR_PATH\}"/);
    assert.match(artifactWorkflow, /codesign --verify --deep --strict --verbose=2 "\$\{app_bundle\}"/);
    assert.match(artifactWorkflow, /test -x "\$\{SIDECAR_PATH\}"/);
    assert.match(artifactWorkflow, /stage-desktop-artifacts\.mjs/);
    assert.match(artifactWorkflow, /if: inputs\.platform == 'all'/);
    assert.match(artifactWorkflow, /--include-size-report/);
    assert.doesNotMatch(artifactWorkflow, /SIDECAR_SHA256SUM\.txt|bundle\/\*\*\/\*/);
    assert.equal(
      artifactWorkflow.indexOf("Build desktop bundle")
        < artifactWorkflow.indexOf("smoke-native-sidecar.mjs"),
      true
    );
    for (const target of [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu"
    ]) {
      assert.match(artifactWorkflow, new RegExp(target));
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/tauri.macos.conf.json"), "utf8")).bundle.targets,
      ["app", "dmg"]
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/tauri.linux.conf.json"), "utf8")).bundle.targets,
      ["deb", "appimage"]
    );

    const launcherPath = join(root, "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu");
    writeFileSync(launcherPath, [
      "#!/usr/bin/env sh",
      "exec node \"$SCRIPT_DIR/main.js\" \"$@\"",
      "#".repeat(5000),
      ""
    ].join("\n"), "utf8");
    const rejected = spawnSync(process.execPath, [
      "--conditions=development",
      "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
      "--check",
      launcherPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Node launcher/);

    const accepted = spawnSync(process.execPath, [
      "--conditions=development",
      "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
      "--check",
      process.execPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);

    const nativeDir = join(root, "native-sidecars");
    mkdirSync(nativeDir);
    const sidecarArtifacts = [
      ["x86_64-apple-darwin", "hunsu-bridge-sidecar-x86_64-apple-darwin", "mach-o"],
      ["aarch64-apple-darwin", "hunsu-bridge-sidecar-aarch64-apple-darwin", "mach-o"],
      ["x86_64-unknown-linux-gnu", "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu", "elf"],
      ["aarch64-unknown-linux-gnu", "hunsu-bridge-sidecar-aarch64-unknown-linux-gnu", "elf"],
      ["x86_64-pc-windows-msvc", "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe", "pe"],
      ["aarch64-pc-windows-msvc", "hunsu-bridge-sidecar-aarch64-pc-windows-msvc.exe", "pe"]
    ] as const;
    for (const [, artifact, kind] of sidecarArtifacts) {
      writeFileSync(join(nativeDir, artifact), fakeNativeExecutable(kind));
    }
    let reportSidecarManifest = "";
    for (const [target, artifact] of sidecarArtifacts) {
      const preparedDist = join(root, `prepared-${target}`);
      mkdirSync(preparedDist);
      writeFileSync(join(preparedDist, "hunsu-bridge-sidecar.exe"), fakeNativeExecutable("pe"));
      writeFileSync(join(preparedDist, "hunsu-bridge-sidecar-x86_64-apple-darwin"), fakeNativeExecutable("mach-o"));
      const prepared = spawnSync(process.execPath, [
        "--conditions=development",
        "apps/bridge-desktop/scripts/prepare-sidecars.mjs",
        "--native-dir",
        nativeDir,
        "--dist-dir",
        preparedDist,
        "--target",
        target
      ], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(prepared.status, 0, prepared.stderr);
      const manifestPath = join(preparedDist, "sidecar-manifest.json");
      const sidecarManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        target: string;
        artifacts: Array<{ target: string; file: string; kind: string }>;
      };
      assert.equal(sidecarManifest.target, target);
      assert.deepEqual(sidecarManifest.artifacts, [{ target, file: artifact, kind: "native-executable" }]);
      assert.deepEqual(readdirSync(preparedDist).filter(file => file.startsWith("hunsu-bridge-sidecar")), [artifact]);
      reportSidecarManifest ||= manifestPath;
    }

    const bundleReportDir = join(root, "bundle-report");
    const artifactSizeReport = join(bundleReportDir, "artifact-size-report.json");
    mkdirSync(bundleReportDir);
    writeFileSync(join(bundleReportDir, "Hunsu Bridge.test-bundle"), "bundle");
    const reported = spawnSync(process.execPath, [
      "apps/bridge-desktop/scripts/report-artifact-sizes.mjs",
      "--directory",
      bundleReportDir,
      "--output",
      artifactSizeReport,
      "--sidecar-manifest",
      reportSidecarManifest,
      "--target",
      sidecarArtifacts[0][0]
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(reported.status, 0, reported.stderr);
    const sizeReport = JSON.parse(readFileSync(artifactSizeReport, "utf8")) as {
      schema: string;
      sidecars: Array<{ target: string; file: string }>;
    };
    assert.equal(sizeReport.schema, "hunsu.bridge-desktop-artifact-sizes.v2");
    assert.deepEqual(sizeReport.sidecars.map(sidecar => sidecar.target), [sidecarArtifacts[0][0]]);
    assert.match(reported.stdout, new RegExp(`sidecar:${sidecarArtifacts[0][0]}`));

    const bundleOnly = spawnSync("pnpm", [
      "--filter",
      "@hunsu/bridge-desktop",
      "sidecars:build",
      "--",
      "--bundle-only"
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.equal(bundleOnly.status, 0, bundleOnly.stderr);
    assert.equal(existsSync(join(process.cwd(), "apps/bridge-desktop/dist/sidecar-bundle.cjs")), true);
    assert.match(bundleOnly.stdout, /\[sidecar-build\] complete bundle-only=true/);

    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      logPath,
      restartLimit: 1,
      restartDelayMs: 20
    });
    supervisor.start();
    await waitForSidecarStatus(supervisor, "crashed", 1);
    assert.equal(supervisor.status().status, "crashed");
    assert.equal(supervisor.status().restartCount, 1);
    assert.match(readFileSync(logPath, "utf8"), /sidecar.crashed/);
  } finally {
    restoreSidecarDist(sidecarDistSnapshot);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App Windows release crate selects the GUI subsystem", () => {
  const tauriSource = readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/src/main.rs"), "utf8");
  assert.equal(
    tauriSource.split(/\r?\n/, 1)[0],
    '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]'
  );
});

test("Bridge App Windows executable validator requires PE GUI subsystem value 2", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-windows-subsystem-test-"));
  const validator = join(process.cwd(), "apps/bridge-desktop/scripts/verify-windows-gui-subsystem.mjs");
  try {
    const guiExecutable = join(root, "hunsu-bridge-gui.exe");
    writeFileSync(guiExecutable, fakeWindowsExecutable(2));
    const accepted = spawnSync(process.execPath, [validator, "--executable", guiExecutable], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /PE Optional Header Subsystem is Windows GUI \(2\)/);

    const cuiExecutable = join(root, "hunsu-bridge-cui.exe");
    writeFileSync(cuiExecutable, fakeWindowsExecutable(3));
    const rejected = spawnSync(process.execPath, [validator, "--executable", cuiExecutable], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /expected Windows GUI \(2\), found Windows CUI \(3\)/);

    const missingExecutable = join(root, "missing-hunsu-bridge.exe");
    const missing = spawnSync(process.execPath, [validator, "--executable", missingExecutable], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Windows release executable is missing/);
    assert.match(missing.stderr, /src-tauri\/target\/release\/hunsu-bridge\.exe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshotSidecarDist(): Map<string, Buffer | undefined> {
  return new Map(SIDECAR_DIST_MUTATED_FILES.map(file => {
    const path = join(SIDECAR_DIST_DIR, file);
    return [path, existsSync(path) ? readFileSync(path) : undefined];
  }));
}

function restoreSidecarDist(snapshot: Map<string, Buffer | undefined>): void {
  mkdirSync(SIDECAR_DIST_DIR, { recursive: true });
  for (const [path, content] of snapshot) {
    if (content === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSyncRetry(path, content);
      if (!path.endsWith(".exe") && path.includes("hunsu-bridge-sidecar")) {
        chmodSync(path, 0o755);
      }
    }
  }
}

function writeFileSyncRetry(path: string, content: Buffer): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tempPath = `${path}.restore-${process.pid}-${attempt}`;
    try {
      writeFileSync(tempPath, content);
      renameSync(tempPath, path);
      return;
    } catch (error) {
      rmSync(tempPath, { force: true });
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ETXTBSY") {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function fakeNativeExecutable(kind: "elf" | "mach-o" | "pe"): Buffer {
  const buffer = Buffer.alloc(4097);
  switch (kind) {
    case "elf":
      buffer.set([0x7f, 0x45, 0x4c, 0x46], 0);
      break;
    case "mach-o":
      buffer.set([0xfe, 0xed, 0xfa, 0xcf], 0);
      break;
    case "pe":
      buffer.set([0x4d, 0x5a, 0x90, 0x00], 0);
      break;
  }
  return buffer;
}

function fakeWindowsExecutable(subsystem: number): Buffer {
  const buffer = Buffer.alloc(512);
  const peOffset = 0x80;
  const coffOffset = peOffset + 4;
  const optionalHeaderOffset = coffOffset + 20;
  buffer.set([0x4d, 0x5a], 0);
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.writeUInt32LE(0x00004550, peOffset);
  buffer.writeUInt16LE(0xf0, coffOffset + 16);
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  buffer.writeUInt16LE(subsystem, optionalHeaderOffset + 68);
  return buffer;
}

type BridgeUiTestElement = {
  textContent: string;
  className: string;
  children: unknown[];
  dataset: Record<string, string>;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  title: string;
  type: string;
  append: (...nodes: unknown[]) => void;
  replaceChildren: (...nodes: unknown[]) => void;
  addEventListener: () => void;
  focus: () => void;
  scrollIntoView: () => void;
  setAttribute: (name: string, value: string) => void;
};

function loadBridgeDesktopUiForTest(): { renderSnapshot: (snapshot: unknown) => void; elements: Map<string, BridgeUiTestElement> } {
  const elements = new Map<string, BridgeUiTestElement>();
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, createBridgeUiTestElement());
      }
      return elements.get(selector);
    },
    querySelectorAll(_selector: string) {
      return [];
    },
    createElement(_tagName: string) {
      return createBridgeUiTestElement();
    },
    createTextNode(value: string) {
      return { textContent: value };
    }
  };
  const window = {
    __TAURI__: undefined,
    location: { href: "" },
    setTimeout: () => 0,
    setInterval: () => 0
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console,
    Promise,
    JSON,
    Date,
    String,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  };
  runInNewContext(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-ui/app.js"), "utf8"), context);
  return {
    renderSnapshot: (context as unknown as { renderSnapshot: (snapshot: unknown) => void }).renderSnapshot,
    elements
  };
}

function createBridgeUiTestElement(): BridgeUiTestElement {
  return {
    textContent: "",
    className: "",
    children: [],
    dataset: {},
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    title: "",
    type: "",
    append(...nodes: unknown[]) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes: unknown[]) {
      this.children = nodes;
    },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    setAttribute(name: string, value: string) {
      if (name === "aria-selected") {
        this.dataset.ariaSelected = value;
      }
    }
  };
}

function textForTestElement(element: unknown): string {
  if (!element || typeof element !== "object") {
    return "";
  }
  const node = element as { textContent?: unknown; children?: unknown[] };
  return [
    typeof node.textContent === "string" ? node.textContent : "",
    ...(node.children ?? []).map(child => textForTestElement(child))
  ].filter(Boolean).join("\n");
}

function bridgeUiStatusFixture() {
  return {
    localBridge: "connected",
    account: "Signed out",
    remoteAccess: "Off",
    device: { name: "Test Device", registered: false },
    service: { installed: false, manager: "manual" }
  };
}

test("Bridge App sidecar supervisor cancels crash restart when stopped intentionally", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-sidecar-stop-test-"));
  const logPath = join(root, "sidecar.log");
  try {
    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      logPath,
      restartLimit: 3,
      restartDelayMs: 200
    });
    supervisor.start();
    await waitForSidecarStatus(supervisor, "crashed", 0);
    assert.equal(supervisor.status().status, "crashed");
    await supervisor.stop();
    await delay(260);
    assert.equal(supervisor.status().status, "stopped");
    assert.equal(supervisor.status().restartCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge App stop terminates the integrated restart supervisor and daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-integrated-stop-"));
  const statePath = join(root, "bridge-app-state.json");
  const logPath = join(root, "bridge-app.log");
  const registryPath = join(root, "roadmaps.json");
  const credentialPath = join(root, "credentials.json");
  const relayRegistryPath = join(root, "relay.json");
  const browserCapturePath = join(root, "browser-capture.log");
  const bridgePort = await getUnusedPort();
  const childEnv = {
    ...process.env,
    HUNSU_BRIDGE_APP_STATE_PATH: statePath,
    HUNSU_BRIDGE_APP_LOG_PATH: logPath,
    HUNSU_ROADMAP_REGISTRY_PATH: registryPath,
    HUNSU_BRIDGE_CREDENTIAL_PATH: credentialPath,
    HUNSU_RELAY_REGISTRY_PATH: relayRegistryPath,
    HUNSU_BRIDGE_PORT: String(bridgePort),
    HUNSU_BRIDGE_TEST_MODE: "1",
    HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH: browserCapturePath
  };
  const child = spawn(process.execPath, [
    "--conditions=development",
    "apps/bridge-desktop/src/main.ts",
    "start",
    "--cwd",
    root,
    "--web-url",
    "http://127.0.0.1:19688/studio",
    "--no-open",
    "--restart-limit",
    "3"
  ], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });

  const envKeys = [
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_BRIDGE_CREDENTIAL_PATH",
    "HUNSU_RELAY_REGISTRY_PATH",
    "HUNSU_BRIDGE_PORT",
    "HUNSU_BRIDGE_TEST_MODE",
    "HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH"
  ];
  const previousEnv = snapshotEnv(envKeys);
  let managedSupervisorPid: number | undefined;
  let managedDaemonPid: number | undefined;
  try {
    await waitFor(async () => {
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { supervisorPid?: number; pid?: number };
      return typeof state.supervisorPid === "number" && typeof state.pid === "number";
    }, 5_000);
    await waitForChildExit(child, 5_000, () => `${stdout}\n${stderr}`);
    const health = await fetch(`http://127.0.0.1:${bridgePort}/health`);
    assert.equal(health.status, 200);

    applyEnv(childEnv, envKeys);
    const initialState = JSON.parse(readFileSync(statePath, "utf8")) as {
      authToken?: string;
      pairing?: unknown;
      controlToken?: string;
      supervisorPid?: number;
      pid?: number;
    };
    managedSupervisorPid = initialState.supervisorPid;
    managedDaemonPid = initialState.pid;
    assert.notEqual(managedSupervisorPid, child.pid);
    assert.equal(initialState.authToken, undefined);
    assert.equal(initialState.pairing, undefined);
    assert.match(initialState.controlToken ?? "", /^hunsu_bridge_control_/);

    const pairLogs: string[] = [];
    const previousPairLog = console.log;
    console.log = (...values: unknown[]) => {
      pairLogs.push(values.map(String).join(" "));
    };
    try {
      assert.equal(await main([
        "pair",
        "--web-url",
        "http://127.0.0.1:19688/studio"
      ]), 0);
    } finally {
      console.log = previousPairLog;
    }
    assert.equal(pairLogs.some(line => line.includes("Hunsu Web opened with a fresh pairing.")), true);
    const pairedState = JSON.parse(readFileSync(statePath, "utf8")) as { authToken?: string; pairing?: unknown; controlToken?: string };
    assert.equal(pairedState.authToken, undefined);
    assert.equal(pairedState.pairing, undefined);
    assert.equal(pairedState.controlToken, initialState.controlToken);
    const capturedUrl = readFileSync(browserCapturePath, "utf8").trim().split(/\r?\n/).at(-1) ?? "";
    const pairedToken = new URL(capturedUrl).searchParams.get("hunsuBridgeToken") ?? "";
    assert.match(pairedToken, /^hunsu_bridge_/);
    const newTokenResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/roadmaps/recent`, {
      headers: { "x-hunsu-bridge-token": pairedToken }
    });
    assert.equal(newTokenResponse.status, 200);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), new RegExp(pairedToken));

    const logs: string[] = [];
    const previousLog = console.log;
    console.log = (...values: unknown[]) => {
      logs.push(values.map(String).join(" "));
    };
    try {
      assert.equal(await main(["stop"]), 0);
    } finally {
      console.log = previousLog;
    }
    assert.equal(logs.some(line => line.includes("Hunsu Bridge stopped.")), true);
    await waitFor(async () => !(await bridgeHealthReachable(bridgePort)), 2_000);
    await delay(900);
    assert.equal(await bridgeHealthReachable(bridgePort), false);
    assert.equal(managedSupervisorPid ? processIsAliveForTest(managedSupervisorPid) : true, false);
    assert.equal(managedDaemonPid ? processIsAliveForTest(managedDaemonPid) : true, false);
    const stoppedState = JSON.parse(readFileSync(statePath, "utf8")) as { supervisorPid?: number; pid?: number };
    assert.equal(stoppedState.supervisorPid, undefined);
    assert.equal(stoppedState.pid, undefined);
  } finally {
    restoreEnv(previousEnv);
    if (child.exitCode === null) child.kill("SIGTERM");
    if (managedSupervisorPid && processIsAliveForTest(managedSupervisorPid)) process.kill(managedSupervisorPid, "SIGTERM");
    if (managedDaemonPid && processIsAliveForTest(managedDaemonPid)) process.kill(managedDaemonPid, "SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

function processIsAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

async function waitForSidecarStatus(
  supervisor: BridgeSidecarSupervisor,
  status: ReturnType<BridgeSidecarSupervisor["status"]>["status"],
  restartCount: number,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = supervisor.status();
    if (current.status === status && current.restartCount === restartCount) {
      return;
    }
    await delay(10);
  }
  const current = supervisor.status();
  assert.fail(`Timed out waiting for sidecar status ${status}/${restartCount}; got ${current.status}/${current.restartCount}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Timed out waiting for condition.");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number, diagnostics: () => string = () => ""): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out waiting for Bridge App child exit.\n${diagnostics()}`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  if (!port) {
    throw new Error("Unable to allocate an unused local port.");
  }
  return port;
}

async function bridgeHealthReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function applyEnv(values: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
