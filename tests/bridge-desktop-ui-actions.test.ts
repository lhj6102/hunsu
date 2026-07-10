import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const appPath = join(process.cwd(), "apps/bridge-desktop/src-ui/app.js");
const htmlPath = join(process.cwd(), "apps/bridge-desktop/src-ui/index.html");

test("Bridge desktop UI exposes awaited feedback and fresh diagnostics contracts", () => {
  const html = readFileSync(htmlPath, "utf8");
  const source = readFileSync(appPath, "utf8");
  assert.match(html, /id="action-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /runCommand\(\["ensure-running", "--json"\]\)/);
  assert.match(source, /runCommand\(\["stop", "--json"\]\)/);
  assert.match(source, /runCommand\(\["diagnostics", "--json"\]\)/);
  assert.doesNotMatch(source, /spawn\(\["(?:pair|open-roadmap|open-project|port|create)"/);
});

test("Validate, Save, Recheck, and provider install expose explicit feedback and prerequisite copy", () => {
  const source = readFileSync(appPath, "utf8");
  assert.match(source, /Validating configuration…/);
  assert.match(source, /Configuration is valid\./);
  assert.match(source, /Configuration is invalid\./);
  assert.match(source, /Provider configuration saved\./);
  assert.match(source, /Provider configuration was not saved\./);
  assert.match(source, /Rechecking Codex…/);
  assert.match(source, /Recheck complete: Codex is ready\./);
  assert.match(source, /Recheck failed\./);
  assert.match(source, /install\.disabled = packageManager\?\.installed !== true/);
  assert.match(source, /Select Existing \$\{provider\.label\}/);
});

test("Bridge desktop UI renders lifecycle ownership controls and runtime semantics", () => {
  const ui = loadUi();
  const snapshot = snapshotFixture();
  ui.renderSnapshot(snapshot);
  assert.equal(ui.element("#start-bridge").disabled, true);
  assert.equal(ui.element("#stop-bridge").disabled, false);
  assert.match(ui.element("#start-bridge").title, /already connected/i);
  assert.match(text(ui.element("#node-card")), /Embedded runtime[\s\S]*Node v22\.22\.0[\s\S]*Bundled with Hunsu Bridge/);
  assert.match(text(ui.element("#node-card")), /System Node[\s\S]*Not installed · Optional/);
  assert.doesNotMatch(text(ui.element("#node-card")), /hunsu-bridge-sidecar\.exe/);
  assert.equal(ui.element("#bridge-app-version").textContent, "0.1.0");
  assert.equal(ui.element("#bridge-runtime-version").textContent, "0.1.2");
  assert.equal(ui.element("#protocol-version").textContent, "local-bridge-v1");
  assert.equal(ui.element("#embedded-node-version").textContent, "v22.22.0");
  assert.equal(ui.element("#codex-cli-version").textContent, "codex 1.2.3");

  ui.renderSnapshot({
    ...snapshot,
    localBridgeControl: {
      state: "connected",
      ownership: "unmanaged",
      canStart: false,
      canStop: false,
      startReason: "Bridge is already connected.",
      stopReason: "This Bridge process is not managed by this app."
    }
  });
  assert.equal(ui.element("#start-bridge").disabled, true);
  assert.equal(ui.element("#stop-bridge").disabled, true);
  assert.match(ui.element("#bridge-control-reason").textContent, /not managed by this app/i);

  ui.renderSnapshot({
    ...snapshot,
    localBridgeControl: {
      state: "not-running",
      ownership: "unknown",
      canStart: true,
      canStop: false,
      stopReason: "Bridge is not running."
    }
  });
  assert.equal(ui.element("#start-bridge").disabled, false);
  assert.equal(ui.element("#stop-bridge").disabled, true);

  for (const state of ["starting", "stopping"] as const) {
    ui.renderSnapshot({
      ...snapshot,
      localBridgeControl: {
        state,
        ownership: "managed",
        canStart: false,
        canStop: false,
        startReason: `Bridge is ${state}.`,
        stopReason: `Bridge is ${state}.`
      }
    });
    assert.equal(ui.element("#start-bridge").disabled, true);
    assert.equal(ui.element("#stop-bridge").disabled, true);
  }
});

test("runUiAction retains visible success and safe failure feedback", async () => {
  const ui = loadUi();
  const button = ui.element("#validate-codex-config");
  const pending = new Promise(resolve => setTimeout(() => resolve({ ok: true, code: "OK", message: "done" }), 0));
  const action = ui.runUiAction({
    id: "test-success",
    pendingMessage: "Validating configuration…",
    successMessage: "Configuration is valid.",
    refreshAfter: false,
    controls: [button],
    execute: () => pending
  });
  assert.equal(button.disabled, true);
  assert.equal(ui.element("#action-status").textContent, "Validating configuration…");
  const duplicate = await ui.runUiAction({
    id: "test-success",
    pendingMessage: "Duplicate…",
    refreshAfter: false,
    execute: async () => ({ ok: true, code: "OK", message: "unexpected" })
  });
  assert.equal(duplicate.code, "UI_ACTION_PENDING");
  const result = await action;
  assert.equal(result.ok, true);
  assert.equal(button.disabled, false);
  assert.equal(ui.element("#action-status").textContent, "Configuration is valid.");

  await ui.runUiAction({
    id: "test-failure",
    pendingMessage: "Opening Hunsu Web…",
    failureMessage: "Hunsu Web could not be opened.",
    refreshAfter: false,
    controls: [button],
    execute: async () => ({
      ok: false,
      code: "BROWSER_OPEN_FAILED",
      message: "failed https://example.test/?hunsuBridgeToken=synthetic-secret"
    })
  });
  assert.match(ui.element("#action-status").textContent, /browser could not be opened/i);
  assert.doesNotMatch(ui.element("#action-status").textContent, /synthetic-secret/);
  assert.equal(button.disabled, false);
});

test("fresh diagnostics copy blocks raw sensitive query values", async () => {
  let clipboard = "";
  let unsafe = false;
  const ui = loadUi({
    clipboardWrite: value => { clipboard = value; },
    invoke: async (command, payload) => {
      assert.equal(command, "run_bridge_app_command");
      const args = payload.input.args as string[];
      if (args[0] === "snapshot") {
        return { status: 0, stdout: JSON.stringify(snapshotFixture()), stderr: "" };
      }
      if (args[0] === "diagnostics-redaction-blocked") {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, code: "OK", message: "Sensitive diagnostics copy was blocked." }),
          stderr: ""
        };
      }
      const value = unsafe
        ? { url: "https://example.test/?hunsuBridgeToken=synthetic-unsafe-token" }
        : { url: "https://example.test/?hunsuBridgeToken=[redacted]", status: "ok" };
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, code: "OK", message: "Diagnostics ready.", value }),
        stderr: ""
      };
    }
  });
  await ui.copyFreshDiagnostics();
  assert.match(clipboard, /\[redacted\]/);
  unsafe = true;
  const blocked = await ui.copyFreshDiagnostics();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DIAGNOSTICS_SENSITIVE_DATA_DETECTED");
  assert.doesNotMatch(clipboard, /synthetic-unsafe-token/);
});

type Element = {
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
  addEventListener: (name: string, handler: (event: unknown) => unknown) => void;
  focus: () => void;
  scrollIntoView: () => void;
  setAttribute: (name: string, value: string) => void;
  querySelector: () => Element | undefined;
};

function loadUi(options: {
  invoke?: (command: string, payload: { input: { args: unknown[] } }) => Promise<unknown>;
  clipboardWrite?: (value: string) => void;
} = {}) {
  const elements = new Map<string, Element>();
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement,
    createTextNode(value: string) { return { textContent: value }; }
  };
  const window = {
    __TAURI__: options.invoke ? { core: { invoke: options.invoke } } : undefined,
    location: { href: "" },
    setTimeout,
    setInterval: () => 0,
    confirm: () => true
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { writeText: async (value: string) => { options.clipboardWrite?.(value); } } },
    console,
    Promise,
    JSON,
    Date,
    String,
    Error,
    Object,
    Array,
    Set,
    Map,
    Number,
    RegExp,
    setTimeout,
    clearTimeout
  };
  runInNewContext(readFileSync(appPath, "utf8"), context);
  const api = context as unknown as {
    renderSnapshot: (snapshot: unknown) => void;
    runUiAction: (input: unknown) => Promise<{ ok: boolean; code?: string }>;
    copyFreshDiagnostics: () => Promise<{ ok?: boolean; code?: string }>;
  };
  return {
    ...api,
    element: (selector: string) => elements.get(selector) ?? createElement()
  };
}

function createElement(): Element {
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
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    setAttribute(name, value) { this.dataset[name] = value; },
    querySelector() { return undefined; }
  };
}

function text(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { textContent?: unknown; children?: unknown[] };
  return [
    typeof node.textContent === "string" ? node.textContent : "",
    ...(node.children ?? []).map(text)
  ].filter(Boolean).join("\n");
}

function snapshotFixture() {
  return {
    status: {
      localBridge: "connected",
      account: "Signed out",
      remoteAccess: "Off",
      device: { name: "Test Device", registered: false },
      service: { installed: false, manager: "manual" },
      quitBehavior: "keep-background"
    },
    localBridgeControl: {
      state: "connected",
      ownership: "managed",
      canStart: false,
      canStop: true,
      startReason: "Bridge is already connected."
    },
    prerequisites: {
      codex: { ready: true },
      tools: {
        git: { installed: true, version: "2.45.0" },
        embeddedRuntime: { kind: "node-sea", installed: true, version: "v22.22.0", bundled: true, binaryPath: "hunsu-bridge-sidecar.exe" },
        systemNode: { installed: false, optional: true },
        packageManager: { installed: false, optional: true }
      }
    },
    versions: {
      bridgeApp: "0.1.0",
      bridgeRuntime: "0.1.2",
      protocol: "local-bridge-v1",
      embeddedNode: "v22.22.0",
      codexCli: "codex 1.2.3"
    },
    providers: {
      currentProviderId: "codex",
      current: { providerId: "codex", label: "Codex", ready: true, recommendedAction: "none", install: { version: "codex 1.2.3" } },
      providers: []
    },
    workspaces: { active: [], inactive: [], managed: [] },
    projectGrants: [],
    diagnostics: { bridge: { version: { bridgeVersion: "0.1.2", protocolVersion: "local-bridge-v1" } } },
    logLines: []
  };
}
