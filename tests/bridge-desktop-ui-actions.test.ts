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
  assert.doesNotMatch(html, /\sstyle=/u);
  assert.doesNotMatch(source, /\.style\.|setAttribute\(["']style["']/u);
  assert.match(source, /actions\.className = "actions space-top-10"/u);
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
  assert.match(source, /install\.disabled = !npmPrerequisite\.available/);
  assert.match(source, /Codex installer requires npm/);
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

test("Bridge desktop UI keeps missing Git and planned provider copy concise", () => {
  const ui = loadUi();
  const snapshot = snapshotFixture();
  ui.renderSnapshot({
    ...snapshot,
    prerequisites: {
      ...snapshot.prerequisites,
      tools: {
        ...snapshot.prerequisites.tools,
        git: {
          installed: false,
          binaryPath: "git",
          error: '\\"git\\" \\"--version\\" is not recognized as an internal or external command.'
        }
      }
    },
    providers: {
      ...snapshot.providers,
      providers: [
        snapshot.providers.current,
        {
          providerId: "claude_code",
          label: "Claude Code",
          ready: false,
          recommendedAction: "configure",
          safeMessage: "Coming later"
        }
      ]
    }
  });

  const gitCopy = text(ui.element("#git-card"));
  assert.match(gitCopy, /Missing[\s\S]*Install Git and make sure it is available on PATH\./);
  assert.doesNotMatch(gitCopy, /--version|not recognized|[\\"]/u);

  const providerCopy = text(ui.element("#runtime-provider-list"));
  assert.equal(providerCopy.match(/Coming later/gu)?.length, 1);
  assert.doesNotMatch(providerCopy, /Coming later\s*·\s*Coming later/u);
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

test("Codex install UI enables only for npm and retains Select Existing Codex", () => {
  const ui = loadUi();
  const missingCodex = providerConfigSnapshotFixture({
    provider: { ready: false, recommendedAction: "install" },
    packageManager: { installed: true, name: "pnpm", version: "10.0.0", optional: true }
  });
  ui.renderSnapshot(missingCodex);
  const blockedInstall = ui.findByText("Install Codex");
  assert.ok(blockedInstall);
  assert.equal(blockedInstall.disabled, true);
  assert.match(blockedInstall.title, /pnpm is available.*requires npm/i);
  assert.ok(ui.findByText("Select Existing Codex"));

  ui.renderSnapshot(providerConfigSnapshotFixture({
    provider: { ready: false, recommendedAction: "install" },
    packageManager: { installed: true, name: "npm", version: "11.0.0", optional: true }
  }));
  const enabledInstall = ui.findByText("Install Codex");
  assert.ok(enabledInstall);
  assert.equal(enabledInstall.disabled, false);
  assert.equal(enabledInstall.title, "Install Codex through npm.");
  assert.ok(ui.findByText("Select Existing Codex"));
});

test("Validate behavior reports success and maps safe field-level failures", async () => {
  let invalid = true;
  const snapshot = providerConfigSnapshotFixture();
  const ui = loadUi({
    invoke: commandDispatcher(() => snapshot, args => {
      if (args[0] === "provider" && args[2] === "validate-json") {
        return commandOutput(invalid
          ? {
              valid: false,
              errors: [{ field: "binaryPath", message: "Choose a real Codex executable." }],
              provider: { safeMessage: "Codex binary is not usable." }
            }
          : { valid: true, errors: [], provider: { ready: true } });
      }
      return commandOutput({ ok: true });
    })
  });
  await ui.refresh({ rethrow: true });
  ui.renderSnapshot(snapshot);
  const validate = ui.element("#validate-codex-config");
  const failed = await ui.runUiAction({
    id: "behavioral-validate-failure",
    pendingMessage: "Validating configuration…",
    successMessage: "Configuration is valid.",
    failureMessage: "Configuration is invalid.",
    refreshAfter: false,
    feedbackElement: ui.element("#provider-config-status"),
    controls: [validate],
    execute: ui.validateCodexConfig
  });
  assert.equal(failed.ok, false);
  assert.match(ui.element("#provider-config-status").textContent, /Configuration is invalid/);
  const binaryPath = ui.findByConfigKey("binaryPath");
  assert.ok(binaryPath);
  assert.equal(binaryPath.getAttribute("aria-invalid"), "true");
  assert.match(binaryPath.title, /real Codex executable/);
  const fieldError = ui.findFieldError("codex-binary-path");
  assert.ok(fieldError);
  assert.equal(fieldError.hidden, false);
  assert.equal(fieldError.textContent, "Choose a real Codex executable.");

  invalid = false;
  const passed = await ui.runUiAction({
    id: "behavioral-validate-success",
    pendingMessage: "Validating configuration…",
    successMessage: "Configuration is valid.",
    failureMessage: "Configuration is invalid.",
    refreshAfter: false,
    feedbackElement: ui.element("#provider-config-status"),
    controls: [validate],
    execute: ui.validateCodexConfig
  });
  assert.equal(passed.ok, true);
  assert.equal(ui.element("#provider-config-status").textContent, "Configuration is valid.");
  assert.equal(binaryPath.getAttribute("aria-invalid"), "false");
  assert.equal(fieldError.hidden, true);
  assert.equal(fieldError.textContent, "");
});

test("Save behavior closes the modal on success and retains it with safe feedback on failure", async () => {
  let saveFails = true;
  const snapshot = providerConfigSnapshotFixture();
  const ui = loadUi({
    invoke: commandDispatcher(() => snapshot, args => {
      if (args[0] === "provider" && args[2] === "save-json") {
        return saveFails
          ? commandFailure("Save rejected https://example.test/?hunsuBridgeToken=synthetic-save-secret")
          : commandOutput({ providerId: "codex", ready: true });
      }
      if (args[0] === "codex" && args[1] === "settings") {
        return commandOutput("Codex settings saved.");
      }
      return commandOutput({ ok: true });
    })
  });
  await ui.refresh({ rethrow: true });
  ui.renderSnapshot(snapshot);
  const dialog = ui.element("#provider-config-dialog");
  const save = ui.element("#save-codex-config");
  dialog.hidden = false;
  const failed = await ui.saveCodexConfigWithFeedback(save);
  assert.equal(failed.ok, false);
  assert.equal(dialog.hidden, false);
  assert.match(ui.element("#provider-config-status").textContent, /Provider configuration was not saved/);
  assert.doesNotMatch(ui.element("#provider-config-status").textContent, /synthetic-save-secret/);

  saveFails = false;
  const passed = await ui.saveCodexConfigWithFeedback(save);
  assert.equal(passed.ok, true);
  assert.equal(dialog.hidden, true);
  assert.equal(ui.element("#provider-config-status").textContent, "Provider configuration saved.");
});

test("Recheck behavior reports timestamped success and safe failure", async () => {
  let recheckFails = true;
  const snapshot = providerConfigSnapshotFixture();
  const ui = loadUi({
    invoke: commandDispatcher(() => snapshot, args => {
      if (args[0] === "codex" && args[1] === "recheck") {
        return recheckFails
          ? commandFailure("Recheck failed https://example.test/?access_token=synthetic-recheck-secret")
          : commandOutput({ ready: true });
      }
      return commandOutput({ ok: true });
    })
  });
  await ui.refresh({ rethrow: true });
  ui.renderSnapshot(snapshot);
  const button = createElement("button");
  const provider = snapshot.providers.current;
  const failed = await ui.runProviderRecheck(provider, button);
  assert.equal(failed.ok, false);
  assert.match(ui.element("#action-status").textContent, /Recheck failed\./);
  assert.match(ui.element("#action-status").textContent, /Completed /);
  assert.doesNotMatch(ui.element("#action-status").textContent, /synthetic-recheck-secret/);

  recheckFails = false;
  const passed = await ui.runProviderRecheck(provider, button);
  assert.equal(passed.ok, true);
  assert.match(ui.element("#action-status").textContent, /Recheck complete: Codex is ready\./);
  assert.match(ui.element("#action-status").textContent, /Completed /);
});

test("failed Pair, Open, Start, and Stop feedback is safe and survives snapshot refresh", async () => {
  let snapshot = providerConfigSnapshotFixture();
  const failures: Record<string, { code: string; message: string; recovery?: { label: string; action: string } }> = {
    pair: { code: "BROWSER_OPEN_FAILED", message: "Pair failed https://example.test/?hunsuBridgeToken=synthetic-action-secret" },
    "open-roadmap": { code: "ROADMAP_NOT_FOUND", message: "Open failed https://example.test/?token=synthetic-action-secret" },
    "ensure-running": {
      code: "BRIDGE_PORT_IN_USE",
      message: "Start failed access_token=synthetic-action-secret",
      recovery: {
        label: "Stop the other process using Bridge port 43127, then select Start Bridge again.",
        action: "retry-start-bridge"
      }
    },
    stop: { code: "BRIDGE_NOT_OWNED", message: "Stop failed Authorization: Bearer synthetic-action-secret" }
  };
  const ui = loadUi({
    invoke: commandDispatcher(() => snapshot, args => {
      const failure = failures[String(args[0])];
      return failure
        ? commandOutput({ ok: false, ...failure })
        : commandOutput({ ok: true });
    })
  });
  await ui.refresh({ rethrow: true });

  const assertions: Array<{ label: string; target: string | (() => Element | undefined); expected: RegExp; snapshot: () => ReturnType<typeof providerConfigSnapshotFixture> }> = [
    {
      label: "Pair",
      target: "#open-studio",
      expected: /browser could not be opened/i,
      snapshot: () => providerConfigSnapshotFixture()
    },
    {
      label: "Open",
      target: () => ui.findByText("Open"),
      expected: /Workspace could not be opened.*could not be found/is,
      snapshot: () => providerConfigSnapshotFixture({ workspace: true })
    },
    {
      label: "Start",
      target: "#start-bridge",
      expected: /Bridge could not be started.*configured Bridge port is in use.*Bridge port 43127.*select Start Bridge again/is,
      snapshot: () => providerConfigSnapshotFixture({ bridgeState: "not-running" })
    },
    {
      label: "Stop",
      target: "#stop-bridge",
      expected: /Bridge could not be stopped.*not managed by this app/is,
      snapshot: () => providerConfigSnapshotFixture({ bridgeState: "connected" })
    }
  ];

  for (const assertion of assertions) {
    snapshot = assertion.snapshot();
    ui.renderSnapshot(snapshot);
    const target = typeof assertion.target === "function" ? assertion.target() : assertion.target;
    assert.ok(target, `${assertion.label} target should be rendered`);
    await ui.click(target);
    await eventually(() => ui.element("#action-status").dataset.state === "error");
    const visible = ui.element("#action-status").textContent;
    assert.match(visible, assertion.expected, `${assertion.label} should show actionable feedback`);
    assert.doesNotMatch(visible, /synthetic-action-secret/, `${assertion.label} should redact the token`);
    await ui.refresh({ rethrow: true });
    assert.equal(ui.element("#action-status").textContent, visible, `${assertion.label} feedback should survive refresh`);
  }
});

type Element = {
  id: string;
  tagName: string;
  textContent: string;
  className: string;
  children: unknown[];
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  listeners: Record<string, Array<(event: unknown) => unknown>>;
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
  getAttribute: (name: string) => string | undefined;
  querySelector: () => Element | undefined;
};

function loadUi(options: {
  invoke?: (command: string, payload: { input: { args: unknown[] } }) => Promise<unknown>;
  clipboardWrite?: (value: string) => void;
} = {}) {
  const elements = new Map<string, Element>();
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        const element = createElement();
        if (selector.startsWith("#")) element.id = selector.slice(1);
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement(tagName: string) { return createElement(tagName); },
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
    refresh: (options?: { rethrow?: boolean }) => Promise<unknown>;
    validateCodexConfig: () => Promise<{ ok: boolean; code?: string }>;
    saveCodexConfigWithFeedback: (button: Element) => Promise<{ ok: boolean; code?: string }>;
    runProviderRecheck: (provider: unknown, button: Element) => Promise<{ ok: boolean; code?: string }>;
  };
  const roots = () => [...elements.values()];
  const find = (predicate: (element: Element) => boolean): Element | undefined => {
    const visit = (value: unknown): Element | undefined => {
      if (!isElement(value)) return undefined;
      if (predicate(value)) return value;
      for (const child of value.children) {
        const match = visit(child);
        if (match) return match;
      }
      return undefined;
    };
    for (const root of roots()) {
      const match = visit(root);
      if (match) return match;
    }
    return undefined;
  };
  return {
    ...api,
    element: (selector: string) => elements.get(selector)
      ?? (selector.startsWith("#") ? find(element => element.id === selector.slice(1)) : undefined)
      ?? createElement(),
    findByText: (label: string) => find(element => element.textContent === label),
    findByConfigKey: (key: string) => find(element => element.dataset.providerConfigKey === key),
    findFieldError: (key: string) => find(element => element.id === `${key}-error`),
    async click(target: string | Element) {
      const element = typeof target === "string"
        ? elements.get(target) ?? find(candidate => candidate.id === target.replace(/^#/u, ""))
        : target;
      assert.ok(element, `Expected UI element ${String(target)}`);
      for (const listener of element.listeners.click ?? []) {
        await listener({ currentTarget: element, target: element });
      }
    }
  };
}

function createElement(tagName = "div"): Element {
  return {
    id: "",
    tagName: tagName.toUpperCase(),
    textContent: "",
    className: "",
    children: [],
    dataset: {},
    attributes: {},
    listeners: {},
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    title: "",
    type: "",
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); },
    focus() {},
    scrollIntoView() {},
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
    },
    getAttribute(name) { return this.attributes[name]; },
    querySelector() { return findElement(this, element => ["INPUT", "SELECT", "BUTTON"].includes(element.tagName)); }
  };
}

function isElement(value: unknown): value is Element {
  return Boolean(value && typeof value === "object" && Array.isArray((value as Element).children));
}

function findElement(root: Element, predicate: (element: Element) => boolean): Element | undefined {
  for (const child of root.children) {
    if (!isElement(child)) continue;
    if (predicate(child)) return child;
    const nested = findElement(child, predicate);
    if (nested) return nested;
  }
  return undefined;
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

function providerConfigSnapshotFixture(options: {
  provider?: { ready: boolean; recommendedAction: string };
  packageManager?: { installed: boolean; name?: "npm" | "pnpm" | "yarn"; version?: string; optional: true };
  bridgeState?: "connected" | "not-running";
  workspace?: boolean;
} = {}) {
  const base = snapshotFixture();
  const bridgeState = options.bridgeState ?? "connected";
  const provider = {
    ...base.providers.current,
    ready: options.provider?.ready ?? true,
    recommendedAction: options.provider?.recommendedAction ?? "none"
  };
  const workspace = {
    roadmapId: "roadmap_behavioral_ui",
    displayName: "Behavioral UI Workspace",
    repositoryPath: "/tmp/behavioral-ui-workspace",
    lifecycle: "active",
    health: "ok",
    primaryAction: "open",
    provider: { providerId: "codex", label: "Codex", readyForExecute: true }
  };
  return {
    ...base,
    status: {
      ...base.status,
      localBridge: bridgeState
    },
    localBridgeControl: bridgeState === "connected"
      ? base.localBridgeControl
      : {
          state: "not-running",
          ownership: "unknown",
          canStart: true,
          canStop: false,
          stopReason: "Bridge is not running."
        },
    prerequisites: {
      ...base.prerequisites,
      codex: { ready: provider.ready },
      tools: {
        ...base.prerequisites.tools,
        packageManager: options.packageManager ?? { installed: true, name: "npm", version: "11.0.0", optional: true }
      }
    },
    providers: {
      ...base.providers,
      current: provider
    },
    providerConfig: {
      providerId: "codex",
      metadata: {
        label: "Codex",
        configKeys: [
          {
            name: "binaryPath",
            label: "Codex binary",
            kind: "file",
            primary: true,
            required: false,
            secret: false
          }
        ]
      },
      fields: [
        { key: "binaryPath", value: "/opt/codex/bin/codex", isSet: true, isSecret: false }
      ]
    },
    codexSettings: { installChannel: "stable" },
    workspaces: options.workspace
      ? { active: [workspace], inactive: [], managed: [workspace] }
      : base.workspaces
  };
}

function commandDispatcher(
  snapshot: () => unknown,
  handle: (args: unknown[]) => unknown
): (command: string, payload: { input: { args: unknown[] } }) => Promise<unknown> {
  return async (command, payload) => {
    assert.equal(command, "run_bridge_app_command");
    const args = payload.input.args;
    if (args[0] === "snapshot") {
      return commandOutput(snapshot());
    }
    return handle(args);
  };
}

function commandOutput(value: unknown): { status: number; stdout: string; stderr: string } {
  return {
    status: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: ""
  };
}

function commandFailure(message: string): { status: number; stdout: string; stderr: string } {
  return { status: 1, stdout: "", stderr: message };
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for UI behavior.");
}
