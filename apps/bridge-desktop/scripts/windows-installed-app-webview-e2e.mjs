import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname } from "node:path";
import { chromium } from "@playwright/test";

const options = parseArguments(process.argv.slice(2));
const browser = await chromium.connectOverCDP(options.endpoint, { timeout: 30_000 });
const pageErrors = [];
const consoleErrors = [];

try {
  const page = await waitForBridgePage(browser);
  page.on("pageerror", error => pageErrors.push(String(error?.message ?? error)));
  page.on("console", message => {
    if (message.type() === "error") {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  await page.locator("#start-bridge").waitFor({ state: "attached", timeout: 30_000 });

  await openLifecycleControls(page);
  await waitForLifecycle(page, {
    localLabel: "Connected",
    startDisabled: true,
    stopDisabled: false
  });

  await verifyLifecycleAction(page, {
    button: "#stop-bridge",
    pendingText: "Stopping Bridge",
    terminalText: "Bridge stopped",
    expected: { localLabel: "Not Running", startDisabled: false, stopDisabled: true }
  });

  await verifyLifecycleAction(page, {
    button: "#start-bridge",
    pendingText: "Starting Bridge",
    terminalText: "Bridge is connected",
    expected: { localLabel: "Connected", startDisabled: true, stopDisabled: false }
  });

  const versionLabels = await verifyVersionLabels(page);
  await verifyProviderRecheck(page);
  await verifyProviderValidation(page);
  const pairingToken = await verifyOpenHunsuWebHandoff(page, options.capturePath);
  const workspaceToken = await verifyWorkspaceOpenHandoff(page, options.capturePath, options.roadmapId);
  const diagnosticsObservation = await verifyDiagnosticsCopy(page, {
    legacySecret: options.legacySecret,
    runtimeTokens: [pairingToken, workspaceToken],
    logPath: options.logPath,
    clipboardExpectationPath: options.clipboardExpectationPath
  });

  await openLifecycleControls(page);
  await verifyLifecycleAction(page, {
    button: "#stop-bridge",
    pendingText: "Stopping Bridge",
    terminalText: "Bridge stopped",
    expected: { localLabel: "Not Running", startDisabled: false, stopDisabled: true }
  });
  await delay(2_500);
  await page.locator("#refresh").click();
  await waitForTerminalFeedback(page, "#action-status", "Bridge status refreshed", 60_000);
  await waitForLifecycle(page, { localLabel: "Not Running", startDisabled: false, stopDisabled: true });
  await verifyPortConflictFeedback(page, options.bridgePort);
  await openAdvancedPanel(page, "advanced");
  mkdirSync(dirname(options.screenshotPath), { recursive: true });
  await page.screenshot({ path: options.screenshotPath, fullPage: true });

  assert(pageErrors.length === 0, `The installed WebView raised ${pageErrors.length} unhandled page error(s).`);
  const consoleErrorSummary = safeConsoleErrorSummary(consoleErrors, [options.legacySecret, pairingToken, workspaceToken]);
  assert(consoleErrors.length === 0,
    `The installed WebView logged ${consoleErrors.length} console error(s): ${JSON.stringify(consoleErrorSummary)}`);
  const evidence = {
    schemaVersion: 1,
    result: "passed",
    candidateKind: "installed-nsis",
    ok: true,
    checks: [
      "silent-isolated-install",
      "installed-webview-cdp",
      "lifecycle-controls",
      "open-handoff-once",
      "workspace-open-handoff-once",
      "exact-workspace-id",
      "diagnostics-copy-redaction",
      "installed-native-clipboard",
      "no-eaddrinuse-log",
      "installed-remains-stopped",
      "ui-port-conflict-feedback",
      "sidecar-no-console-window",
      "live-migration-revocation",
      "no-webview-console-errors",
      "visual-screenshot",
      "provider-validate-recheck-feedback",
      "version-labels"
    ],
    observations: {
      lifecycleTransitions: ["connected-managed", "not-running", "connected-managed", "not-running"],
      portConflictFeedback: "The local Bridge port is in use by another process.",
      workspaceRoadmapIdMatched: true,
      browserHandoffs: { web: 1, workspace: 1 },
      diagnosticsSha256: diagnosticsObservation.diagnosticsSha256,
      sanitizedLogSha256: diagnosticsObservation.logSha256,
      screenshotFile: basename(options.screenshotPath),
      versionLabels
    },
    releaseGate: {
      automatedInstalledAppQa: "passed",
      manualVisualQa: "required",
      releaseEligible: false
    }
  };
  if (options.evidencePath) {
    mkdirSync(dirname(options.evidencePath), { recursive: true });
    writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close().catch(() => undefined);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid installed-app E2E argument near ${key ?? "end of command"}.`);
    }
    values.set(key.slice(2), value);
  }
  const required = [
    "endpoint",
    "capture-path",
    "log-path",
    "legacy-secret",
    "roadmap-id",
    "bridge-port",
    "screenshot-path",
    "clipboard-expectation-path"
  ];
  for (const key of required) {
    if (!values.get(key)) throw new Error(`Missing required installed-app E2E argument: --${key}`);
  }
  const bridgePort = Number(values.get("bridge-port"));
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    throw new Error("Installed-app E2E --bridge-port must be an integer from 1 through 65535.");
  }
  return {
    endpoint: values.get("endpoint"),
    capturePath: values.get("capture-path"),
    logPath: values.get("log-path"),
    legacySecret: values.get("legacy-secret"),
    roadmapId: values.get("roadmap-id"),
    bridgePort,
    screenshotPath: values.get("screenshot-path"),
    clipboardExpectationPath: values.get("clipboard-expectation-path"),
    evidencePath: values.get("evidence-path")
  };
}

async function waitForBridgePage(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(context => context.pages());
    for (const page of pages) {
      const title = await page.title().catch(() => "");
      const hasBridgeUi = await page.locator("#start-bridge").count().catch(() => 0);
      if (hasBridgeUi > 0 || title === "Hunsu Bridge") return page;
    }
    await delay(200);
  }
  throw new Error("Playwright connected to WebView2, but the installed Hunsu Bridge page target was not found.");
}

async function openLifecycleControls(page) {
  await page.locator('nav button[data-tab="connection"]').click();
  const details = page.locator('section[data-panel="connection"] details');
  if (!(await details.evaluate(element => element.open))) {
    await details.locator("summary").click();
  }
  await page.locator("#start-bridge").waitFor({ state: "visible" });
}

async function verifyLifecycleAction(page, input) {
  await armTransitionTrace(page, "#action-status");
  await page.locator(input.button).click();
  await waitForTerminalFeedback(page, "#action-status", input.terminalText, 60_000);
  await waitForLifecycle(page, input.expected);
  const trace = await readTransitionTrace(page);
  assert(
    trace.some(entry => entry.state === "pending" && entry.text.includes(input.pendingText)),
    `${input.button} did not expose its pending action feedback.`
  );
  assert(
    trace.some(entry => entry.state === "pending" && entry.startDisabled && entry.stopDisabled),
    `${input.button} did not disable both lifecycle controls while pending.`
  );
  assert(!(await page.locator(input.button).isDisabled()) || input.expected.startDisabled || input.expected.stopDisabled,
    `${input.button} remained disabled for an unexpected reason after completion.`);
}

async function waitForLifecycle(page, expected) {
  await page.waitForFunction(value => {
    const local = document.querySelector("#local-bridge")?.textContent?.trim().toLocaleLowerCase() ?? "";
    const expectedLocal = `local · ${value.localLabel}`.toLocaleLowerCase();
    const start = document.querySelector("#start-bridge");
    const stop = document.querySelector("#stop-bridge");
    return local.includes(expectedLocal)
      && start?.disabled === value.startDisabled
      && stop?.disabled === value.stopDisabled;
  }, expected, { timeout: 60_000 });
}

async function verifyVersionLabels(page) {
  await openAdvancedPanel(page, "advanced");
  const labels = {
    bridgeApp: (await page.locator("#bridge-app-version").textContent())?.trim() ?? "",
    bridgeRuntime: (await page.locator("#bridge-runtime-version").textContent())?.trim() ?? "",
    protocol: (await page.locator("#protocol-version").textContent())?.trim() ?? "",
    embeddedNode: (await page.locator("#embedded-node-version").textContent())?.trim() ?? "",
    codexCli: (await page.locator("#codex-cli-version").textContent())?.trim() ?? ""
  };
  for (const [name, label] of Object.entries(labels)) {
    assert(label.length > 0 && label !== "Unknown" && label !== "Unavailable",
      `Installed app version label ${name} was not resolved (received ${JSON.stringify(label)}).`);
  }
  assert(/^v?\d+\.\d+\.\d+/u.test(labels.bridgeApp), "Bridge App version label is not a semantic version.");
  assert(/^v?\d+\.\d+\.\d+/u.test(labels.bridgeRuntime), "Bridge runtime version label is not a semantic version.");
  assert(labels.protocol.includes("local-bridge"), "Protocol version label did not identify the local Bridge protocol.");
  assert(/^v\d+\.\d+\.\d+/u.test(labels.embeddedNode), "Embedded Node version label is not exact.");
  assert(labels.codexCli.includes("codex-qa 0.0.0"),
    `Codex CLI version did not come from the controlled installed-app fixture (received ${JSON.stringify(labels.codexCli)}).`);
  console.log(`[installed-app-e2e] version labels passed: ${JSON.stringify(labels)}`);
  return labels;
}

async function verifyProviderRecheck(page) {
  await page.locator('nav button[data-tab="provider"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll("#codex-card button")]
    .some(button => button.textContent?.trim() === "Recheck"), undefined, { timeout: 30_000 });
  const button = page.getByRole("button", { name: "Recheck", exact: true }).first();
  await armTransitionTrace(page, "#action-status");
  await button.click();
  await waitForTerminalFeedback(page, "#action-status", "Recheck complete", 60_000);
  const trace = await readTransitionTrace(page);
  assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Rechecking Codex")),
    "Recheck did not expose pending feedback.");
  const terminal = await page.locator("#action-status").textContent();
  assert(terminal?.includes("Completed "), "Recheck terminal feedback did not include its completion time.");
  assert(!(await button.isDisabled()), "Recheck remained disabled after reaching terminal feedback.");
}

async function verifyProviderValidation(page) {
  await openAdvancedPanel(page, "settings");
  await page.locator("#open-provider-config-settings").click();
  await page.locator("#provider-config-dialog").waitFor({ state: "visible" });
  await armTransitionTrace(page, "#provider-config-status");
  const button = page.locator("#validate-codex-config");
  await button.click();
  await page.waitForFunction(() => {
    const status = document.querySelector("#provider-config-status");
    return status?.dataset.state === "success" || status?.dataset.state === "error";
  }, undefined, { timeout: 60_000 });
  const trace = await readTransitionTrace(page);
  assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Validating configuration")),
    "Validate did not expose pending feedback.");
  const terminalText = (await page.locator("#provider-config-status").textContent())?.trim() ?? "";
  assert(terminalText.length > 0 && !terminalText.includes("Validating configuration"),
    "Validate did not expose terminal feedback.");
  assert(!(await button.isDisabled()), "Validate remained disabled after reaching terminal feedback.");
  await page.locator("#close-provider-config").click();
}

async function verifyOpenHunsuWebHandoff(page, capturePath) {
  const before = nonemptyFileLines(capturePath);
  await armTransitionTrace(page, "#action-status");
  await page.locator("#open-studio").click();
  await waitForTerminalFeedback(page, "#action-status", "Hunsu Web opened", 60_000);
  const deadline = Date.now() + 15_000;
  let after = nonemptyFileLines(capturePath);
  while (after.length !== before.length + 1 && Date.now() < deadline) {
    await delay(100);
    after = nonemptyFileLines(capturePath);
  }
  assert(after.length === before.length + 1, "Open Hunsu Web did not produce exactly one browser handoff.");
  const capturedUrl = new URL(after.at(-1));
  const pairingToken = capturedUrl.searchParams.get("hunsuBridgeToken");
  assert(pairingToken, "The isolated test capture did not receive a transient pairing token.");
  const trace = await readTransitionTrace(page);
  assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Opening Hunsu Web")),
    "Open Hunsu Web did not expose pending feedback.");
  const documentText = await page.locator("body").innerText();
  assert(!documentText.includes(pairingToken), "The installed WebView exposed the transient pairing token.");
  return pairingToken;
}

async function verifyWorkspaceOpenHandoff(page, capturePath, roadmapId) {
  await page.locator("#refresh").click();
  await waitForTerminalFeedback(page, "#action-status", "Bridge status refreshed", 60_000);
  await page.locator('nav button[data-tab="workspaces"]').click();
  const openButton = page.locator("#active-roadmap-list button", { hasText: "Open" }).first();
  await openButton.waitFor({ state: "visible", timeout: 30_000 });
  const before = nonemptyFileLines(capturePath);
  await armTransitionTrace(page, "#action-status");
  await openButton.click();
  await waitForTerminalFeedback(page, "#action-status", "Workspace opened", 60_000);
  const deadline = Date.now() + 15_000;
  let after = nonemptyFileLines(capturePath);
  while (after.length !== before.length + 1 && Date.now() < deadline) {
    await delay(100);
    after = nonemptyFileLines(capturePath);
  }
  assert(after.length === before.length + 1, "Workspace Open did not produce exactly one browser handoff.");
  const capturedUrl = new URL(after.at(-1));
  const workspaceToken = capturedUrl.searchParams.get("hunsuBridgeToken");
  assert(workspaceToken, "Workspace Open did not receive a transient pairing token.");
  assert(capturedUrl.pathname === `/studio/roadmaps/${encodeURIComponent(roadmapId)}`,
    "Workspace Open did not target the requested Roadmap ID.");
  const trace = await readTransitionTrace(page);
  assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Opening Workspace")),
    "Workspace Open did not expose pending feedback.");
  const documentText = await page.locator("body").innerText();
  assert(!documentText.includes(workspaceToken), "The installed WebView exposed the Workspace pairing token.");
  return workspaceToken;
}

async function verifyDiagnosticsCopy(page, input) {
  await openAdvancedPanel(page, "diagnostics");
  await armTransitionTrace(page, "#action-status");
  await page.locator("#copy-diagnostics").click();
  await waitForTerminalFeedback(page, "#action-status", "Diagnostics copied", 60_000);
  const displayedText = await page.locator("#diagnostics").textContent() ?? "";
  assert(displayedText.length > 0, "Copy Diagnostics did not render a payload.");
  assertSafeDiagnosticsText(displayedText, input.legacySecret, input.runtimeTokens);
  mkdirSync(dirname(input.clipboardExpectationPath), { recursive: true });
  writeFileSync(input.clipboardExpectationPath, displayedText, { encoding: "utf8", mode: 0o600 });
  const sanitizedLog = readFileSync(input.logPath, "utf8");
  assertSafeDiagnosticsText(sanitizedLog, input.legacySecret, input.runtimeTokens);
  assert(!sanitizedLog.includes("EADDRINUSE"), "The installed-app log contains EADDRINUSE.");
  const trace = await readTransitionTrace(page);
  assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Preparing fresh diagnostics")),
    "Copy Diagnostics did not expose pending feedback.");
  return {
    diagnosticsSha256: sha256(displayedText),
    logSha256: sha256(sanitizedLog)
  };
}

function assertSafeDiagnosticsText(text, legacySecret, runtimeTokens) {
  assert(!text.includes(legacySecret), "Diagnostics retained the seeded legacy secret.");
  for (const token of runtimeTokens) {
    assert(!text.includes(token), "Diagnostics exposed a transient pairing token.");
  }
  assert(!/Authorization\s*[:=]\s*Bearer\s+(?!\[redacted\])[^\s"']+/iu.test(text),
    "Diagnostics exposed a bearer credential.");
  const sensitiveQuery = /[?&](?:hunsuBridgeToken|hunsuRelayToken|token|access_token|refresh_token|authorization|code|state)=([^&#\s"']*)/giu;
  for (const match of text.matchAll(sensitiveQuery)) {
    const value = decodeURIComponent(match[1]).toLowerCase();
    assert(["", "[redacted]", "redacted", "***"].includes(value),
      "Diagnostics retained an unredacted sensitive query value.");
  }
}

async function verifyPortConflictFeedback(page, bridgePort) {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(bridgePort, "127.0.0.1", resolve);
  });
  try {
    await openLifecycleControls(page);
    await armTransitionTrace(page, "#action-status");
    await page.locator("#start-bridge").click();
    await page.waitForFunction(() => {
      const status = document.querySelector("#action-status");
      return status?.dataset.state === "error"
        && status.textContent?.includes("The local Bridge port is in use by another process.");
    }, undefined, { timeout: 60_000 });
    assert(!(await page.locator("#start-bridge").isDisabled()), "Start did not recover after actionable port-conflict feedback.");
    assert(await page.locator("#stop-bridge").isDisabled(), "Stop became available for an unrelated port owner.");
    const trace = await readTransitionTrace(page);
    assert(trace.some(entry => entry.state === "pending" && entry.text.includes("Starting Bridge")),
      "Port-conflict Start did not expose pending feedback.");
    await delay(3_000);
    assert(server.listening, "The Bridge disturbed the unrelated port-conflict listener.");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function openAdvancedPanel(page, panelName) {
  const advanced = page.locator("main > details");
  if (!(await advanced.evaluate(element => element.open))) {
    await advanced.locator("summary").click();
  }
  await page.locator(`main > details button[data-tab="${panelName}"]`).click();
  await page.locator(`section[data-panel="${panelName}"]`).waitFor({ state: "visible" });
}

async function waitForTerminalFeedback(page, selector, terminalText, timeout) {
  await page.waitForFunction(({ target, text }) => {
    const element = document.querySelector(target);
    return element?.dataset.state === "success" && element.textContent?.includes(text);
  }, { target: selector, text: terminalText }, { timeout });
}

async function armTransitionTrace(page, statusSelector) {
  await page.evaluate(selector => {
    window.__hunsuQaTraceObserver?.disconnect();
    window.__hunsuQaTrace = [];
    const status = document.querySelector(selector);
    const start = document.querySelector("#start-bridge");
    const stop = document.querySelector("#stop-bridge");
    const record = () => window.__hunsuQaTrace.push({
      state: status?.dataset.state ?? "",
      text: status?.textContent ?? "",
      startDisabled: start?.disabled === true,
      stopDisabled: stop?.disabled === true
    });
    const observer = new MutationObserver(record);
    if (status) observer.observe(status, { attributes: true, childList: true, subtree: true });
    if (start) observer.observe(start, { attributes: true });
    if (stop) observer.observe(stop, { attributes: true });
    window.__hunsuQaTraceObserver = observer;
    record();
  }, statusSelector);
}

async function readTransitionTrace(page) {
  return page.evaluate(() => window.__hunsuQaTrace ?? []);
}

function nonemptyFileLines(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeConsoleErrorSummary(errors, secrets) {
  return errors.slice(0, 50).map(error => ({
    text: redactConsoleError(error.text, secrets).slice(0, 500),
    source: redactConsoleUrl(error.location?.url ?? "", secrets),
    line: Number(error.location?.lineNumber ?? 0),
    column: Number(error.location?.columnNumber ?? 0)
  }));
}

function redactConsoleError(value, secrets) {
  let safe = String(value ?? "");
  for (const secret of secrets.filter(Boolean)) {
    safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/([?&](?:hunsuBridgeToken|hunsuRelayToken|token|access_token|refresh_token|authorization|code|state)=)[^&#\s"']*/giu, "$1[redacted]")
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(["']?(?:authToken|controlToken|hunsuBridgeToken|hunsuRelayToken|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/giu, "$1[redacted]")
    .replace(/\b(?:bridge_test|control_test|qa_legacy)_[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redacted]");
}

function redactConsoleUrl(value, secrets) {
  const safe = redactConsoleError(value, secrets);
  try {
    const url = new URL(safe);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
  } catch (_error) {
    return safe.slice(0, 500);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
