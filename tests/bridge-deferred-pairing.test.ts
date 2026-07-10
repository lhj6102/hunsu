import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeSupervisor } from "../apps/bridge/src/index.ts";
import { resolveBridgeRuntimeConfig, unwrapConfigResult } from "../packages/config/src/index.ts";

test("managed Bridge startup defers pairing until an authenticated user action", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hunsu-deferred-pairing-"));
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig({}, { cwd }));
  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd,
    webUrl: "http://127.0.0.1:19688/studio",
    noOpen: true,
    deferPairing: true,
    runtimeConfig: {
      ...runtimeConfig,
      bridgeApi: { ...runtimeConfig.bridgeApi, port: 0 }
    }
  });
  try {
    assert.equal(handle.pairingState, "unpaired");
    assert.equal(handle.authToken, undefined);
    assert.equal(handle.pairing, undefined);

    const beforePair = await fetch(`${handle.bridgeApiUrl}/api/roadmaps/recent`);
    assert.equal(beforePair.status, 401);
    assert.equal((await beforePair.json()).code, "pairing_token_missing");

    const status = await fetch(`${handle.bridgeApiUrl}/api/bridge/control/status`, {
      headers: { "x-hunsu-bridge-control-token": handle.controlToken }
    });
    assert.equal(status.status, 200);

    const rotate = await fetch(`${handle.bridgeApiUrl}/api/bridge/pairing/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hunsu-bridge-control-token": handle.controlToken
      },
      body: JSON.stringify({ webUrl: "http://127.0.0.1:19688/studio" })
    });
    assert.equal(rotate.status, 202);
    const rotated = await rotate.json() as { authToken: string };
    assert.match(rotated.authToken, /^hunsu_bridge_/);

    const afterPair = await fetch(`${handle.bridgeApiUrl}/api/roadmaps/recent`, {
      headers: { "x-hunsu-bridge-token": rotated.authToken }
    });
    assert.equal(afterPair.status, 200);
  } finally {
    await supervisor.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
