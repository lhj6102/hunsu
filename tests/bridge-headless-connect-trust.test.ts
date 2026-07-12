import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBridgeDaemon, type RunningBridgeDaemon } from "../apps/bridge/src/daemon/daemon.ts";

const TRUST_NAMES = [
  "HUNSU_DEVELOPMENT_CONNECT_TICKET_ISSUER",
  "HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_KEY_ID",
  "HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_PUBLIC_JWK"
] as const;

test("installed daemons reject every development Connect trust override", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-installed-connect-trust-"));
  try {
    for (const name of TRUST_NAMES) {
      await assert.rejects(startBridgeDaemon({
        home: join(root, name),
        cwd: root,
        host: "127.0.0.1",
        port: 0,
        deploymentProfile: "production",
        development: false,
        env: { [name]: "untrusted-development-value" }
      }), /reject development Connect signing-trust overrides/u);
    }
    await assert.rejects(startBridgeDaemon({
      home: join(root, "empty-override"),
      cwd: root,
      host: "127.0.0.1",
      port: 0,
      deploymentProfile: "production",
      development: false,
      env: { HUNSU_DEVELOPMENT_CONNECT_TICKET_ISSUER: "" }
    }), /reject development Connect signing-trust overrides/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development Connect trust is all-or-nothing, loopback-only, pathless, and same-origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-development-connect-trust-"));
  const publicJwk = await fixturePublicJwk();
  const trust = {
    HUNSU_DEVELOPMENT_CONNECT_TICKET_ISSUER: "http://127.0.0.1:31991",
    HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_KEY_ID: "connect-fixture-signing-key-01",
    HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_PUBLIC_JWK: JSON.stringify(publicJwk)
  };
  const endpoints = {
    HUNSU_CONNECT_API_BASE_URL: "http://127.0.0.1:31991",
    HUNSU_CONNECT_WS_URL: "ws://127.0.0.1:31991/v1/connect/device"
  };
  let daemon: RunningBridgeDaemon | undefined;
  try {
    for (const omitted of TRUST_NAMES) {
      const partial = { ...trust };
      delete partial[omitted];
      await assert.rejects(startBridgeDaemon({
        home: join(root, `partial-${omitted}`),
        cwd: root,
        host: "127.0.0.1",
        port: 0,
        deploymentProfile: "preview",
        development: true,
        env: { ...endpoints, ...partial }
      }), /requires issuer, key id, and public JWK together/u);
    }

    const invalidEndpoints = [
      {
        HUNSU_CONNECT_API_BASE_URL: "https://connect.example.test",
        HUNSU_CONNECT_WS_URL: "wss://connect.example.test/v1/connect/device",
        HUNSU_DEVELOPMENT_CONNECT_TICKET_ISSUER: "https://connect.example.test"
      },
      { HUNSU_CONNECT_API_BASE_URL: "http://127.0.0.1:31991/nested" },
      { HUNSU_CONNECT_API_BASE_URL: "http://127.0.0.1:31991?mode=fixture" },
      { HUNSU_CONNECT_WS_URL: "ws://127.0.0.1:31991/v1/connect/device?mode=fixture" },
      { HUNSU_CONNECT_WS_URL: "ws://127.0.0.1:31992/v1/connect/device" }
    ];
    for (const [index, invalid] of invalidEndpoints.entries()) {
      await assert.rejects(startBridgeDaemon({
        home: join(root, `invalid-${index}`),
        cwd: root,
        host: "127.0.0.1",
        port: 0,
        deploymentProfile: "preview",
        development: true,
        env: { ...endpoints, ...trust, ...invalid }
      }), /limited to an exact loopback HTTP\/WS fixture/u);
    }

    daemon = await startBridgeDaemon({
      home: join(root, "valid"),
      cwd: root,
      host: "127.0.0.1",
      port: 0,
      webUrl: "http://127.0.0.1:31990/studio",
      deploymentProfile: "preview",
      development: true,
      env: { ...endpoints, ...trust }
    });
    const health = await fetch(new URL("/health", daemon.identity.endpoint));
    assert.equal(health.ok, true);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixturePublicJwk(): Promise<JsonWebKey> {
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}
