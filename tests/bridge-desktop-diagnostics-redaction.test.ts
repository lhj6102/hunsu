import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertDiagnosticsSafe,
  redactDiagnosticText,
  redactDiagnosticUrl,
  sanitizeDiagnostics
} from "../apps/bridge/src/index.ts";
import { buildDiagnostics } from "../apps/bridge-desktop/src/commands/diagnosticsCommands.ts";
import { BridgeSidecarSupervisor } from "../apps/bridge-desktop/src/sidecar-supervisor.ts";
import { defaultBridgeAppState } from "../apps/bridge-desktop/src/state/appState.ts";

const sensitiveQueryParameters = [
  "hunsuBridgeToken",
  "hunsuRelayToken",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "code",
  "state"
] as const;

test("product diagnostics redaction removes parameter-aware synthetic tokens from nested text and JSON", () => {
  const firstToken = syntheticToken("first");
  const secondToken = syntheticToken("second");
  const firstUrl = `https://hunsu.app/studio?roadmapId=roadmap_123&hunsuBridgeToken=${encodeURIComponent(firstToken)}`;
  const secondUrl = `https://relay.hunsu.app/connect?hUnSuReLaYtOkEn=${encodeURIComponent(secondToken)}&mode=diagnostic`;

  const redactedUrl = redactDiagnosticUrl(firstUrl);
  assert.match(redactedUrl, /roadmapId=roadmap_123/u);
  assert.match(redactedUrl, /hunsuBridgeToken=\[redacted\]/u);
  assert.equal(redactedUrl.includes(firstToken), false);

  const rawLogLine = JSON.stringify({
    event: "bridge.test",
    url: secondUrl,
    nested: JSON.stringify({ pairingUrl: firstUrl })
  });
  const safeLogLine = redactDiagnosticText(rawLogLine);
  assert.equal(safeLogLine.includes(firstToken), false);
  assert.equal(safeLogLine.includes(secondToken), false);

  const allParametersUrl = new URL("https://hunsu.app/callback");
  for (const [index, name] of sensitiveQueryParameters.entries()) {
    allParametersUrl.searchParams.set(name, index % 2 === 0 ? firstToken : secondToken);
  }
  allParametersUrl.searchParams.set("roadmapId", "roadmap_safe");
  const sanitized = sanitizeDiagnostics({
    rawLogLine,
    nested: [{ url: allParametersUrl.toString() }],
    serialized: JSON.stringify({ output: `GET ${firstUrl}` })
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(firstToken), false);
  assert.equal(serialized.includes(secondToken), false);
  assert.match(serialized, /roadmap_safe/u);
  assert.doesNotThrow(() => assertDiagnosticsSafe(sanitized));

  let unsafeError: unknown;
  try {
    assertDiagnosticsSafe({ url: firstUrl });
  } catch (error) {
    unsafeError = error;
  }
  assert.ok(unsafeError instanceof Error);
  assert.equal(unsafeError.message, "Diagnostics contain sensitive data.");
  assert.equal(unsafeError.message.includes(firstToken), false);
});

test("buildDiagnostics sanitizes and verifies the complete command payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-diagnostics-build-test-"));
  const firstToken = syntheticToken("health");
  const secondToken = syntheticToken("codex");
  const healthUrl = `http://127.0.0.1/health?hunsuBridgeToken=${encodeURIComponent(firstToken)}`;
  const codexUrl = `https://hunsu.app/provider?access_token=${encodeURIComponent(secondToken)}`;
  const state = {
    ...defaultBridgeAppState(),
    authToken: firstToken,
    controlToken: secondToken,
    pendingAuth: {
      state: firstToken,
      codeVerifier: secondToken,
      redirectUri: "https://hunsu.app/callback",
      authBaseUrl: "https://hunsu.app",
      startedAt: new Date().toISOString()
    },
    codex: {
      binaryPath: `/opt/codex?hunsuRelayToken=${encodeURIComponent(secondToken)}`
    }
  };

  try {
    const diagnostics = await buildDiagnostics({
      appStatePath: () => join(root, "state.json"),
      appLogPath: () => join(root, "bridge.log"),
      credentialPath: () => join(root, "credentials.json"),
      relayRegistryPath: () => join(root, "relay.json"),
      readState: () => state,
      readBridgeHealth: async () => ({ url: healthUrl }),
      snapshotProjectGrants: grants => grants,
      activeManagedProjectGrants: grants => grants,
      roadmapRegistryOptions: () => ({ roadmapRegistryPath: join(root, "roadmaps.json") }),
      safeCodexDiagnostics: async () => ({
        url: codexUrl,
        output: JSON.stringify({ url: healthUrl })
      }),
      cwd: () => root
    });

    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(firstToken), false);
    assert.equal(serialized.includes(secondToken), false);
    assert.doesNotThrow(() => assertDiagnosticsSafe(diagnostics));
    assert.deepEqual(
      (diagnostics as { app: { pendingAuth: unknown } }).app.pendingAuth,
      { present: true, startedAt: state.pendingAuth.startedAt }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BridgeSidecarSupervisor never persists raw synthetic tokens from args or process output", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sidecar-redaction-test-"));
  const logPath = join(root, "sidecar.log");
  const firstToken = syntheticToken("argument");
  const secondToken = syntheticToken("output");
  const argumentUrl = `https://hunsu.app/studio?hunsuBridgeToken=${encodeURIComponent(firstToken)}`;
  const outputUrl = `https://relay.hunsu.app/connect?hunsuRelayToken=${encodeURIComponent(secondToken)}`;
  const childScript = `console.log(${JSON.stringify(argumentUrl)}); console.error(JSON.stringify({ url: ${JSON.stringify(outputUrl)} }));`;

  try {
    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", childScript, "--", "--auth-token", firstToken],
      logPath,
      restartLimit: 0
    });
    supervisor.start();
    await waitForTerminalSupervisorStatus(supervisor);

    const log = readFileSync(logPath, "utf8");
    assert.equal(log.includes(firstToken), false);
    assert.equal(log.includes(secondToken), false);
    assert.match(log, /\[redacted\]/u);
    for (const line of log.trim().split(/\r?\n/u)) {
      assert.doesNotThrow(() => assertDiagnosticsSafe(JSON.parse(line)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop Copy Diagnostics requests a fresh payload and blocks unsafe clipboard text", () => {
  const source = readFileSync("apps/bridge-desktop/src-ui/app.js", "utf8");
  const copyStart = source.indexOf("async function copyFreshDiagnostics");
  const copyEnd = source.indexOf('providerConfigSettingsOpen?.addEventListener', copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart);
  const copySource = source.slice(copyStart, copyEnd);
  assert.match(copySource, /(?:run|runCommand)\(\["diagnostics"(?:, "--json")?\]\)/u);
  assert.match(copySource, /assertDiagnosticsSafe|diagnosticTextIsSafe/u);
  assert.match(copySource, /navigator\.clipboard\.writeText/u);
  assert.doesNotMatch(copySource, /writeText\(diagnostics\.textContent/u);
  assert.match(copySource, /Diagnostics could not be copied because sensitive data was detected\./u);
  assert.match(copySource, /CLIPBOARD_WRITE_FAILED/u);
  assert.match(copySource, /Diagnostics are safe, but Windows could not write them to the clipboard\./u);
  assert.equal(copySource.match(/diagnostics-redaction-blocked/gu)?.length, 1);
  const clipboardWrite = copySource.indexOf("navigator.clipboard.writeText");
  assert.ok(clipboardWrite >= 0);
  assert.doesNotMatch(copySource.slice(clipboardWrite), /diagnostics-redaction-blocked/u);
  assert.match(source, /CLIPBOARD_WRITE_FAILED:\s*"Diagnostics are safe, but Windows could not write them to the clipboard\."/u);

  const safetyStart = source.indexOf("function diagnosticTextIsSafe");
  if (safetyStart >= 0) {
    const safetyEnd = source.indexOf('\ndocument.querySelector("#copy-diagnostics")', safetyStart);
    assert.ok(safetyEnd > safetyStart);
    const safety = Function(`${source.slice(safetyStart, safetyEnd)}; return diagnosticTextIsSafe;`)() as (value: string) => boolean;
    const token = syntheticToken("clipboard");
    assert.equal(safety(`https://hunsu.app/studio?hunsuBridgeToken=${token}`), false);
    assert.equal(safety("https://hunsu.app/studio?hunsuBridgeToken=[redacted]"), true);
  } else {
    assert.match(copySource, /assertDiagnosticTextSafe\(text\)/u);
  }
});

function syntheticToken(label: string): string {
  return `bridge_test_${label}_${randomBytes(24).toString("base64url")}`;
}

async function waitForTerminalSupervisorStatus(supervisor: BridgeSidecarSupervisor): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = supervisor.status().status;
    if (status === "crashed" || status === "stopped") {
      return;
    }
    await delay(20);
  }
  assert.fail(`Timed out waiting for sidecar completion; current status is ${supervisor.status().status}.`);
}
