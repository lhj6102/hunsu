import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const ip = require("../packages/ip-safe/index.cjs") as {
  isLoopback(value: string): boolean;
  isV4Format(value: string): boolean;
  toBuffer(value: string, target?: Uint8Array, offset?: number): Uint8Array;
  toString(value: Uint8Array, offset?: number, length?: number): string;
};

test("audited WebRTC IP shim handles only strict IPv4/IPv6 codec operations", () => {
  assert.equal(ip.isLoopback("127.0.0.1"), true);
  assert.equal(ip.isLoopback("::1"), true);
  assert.equal(ip.isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(ip.isLoopback("127.1"), false);
  assert.equal(ip.isLoopback("012.1.2.3"), false);
  assert.equal(ip.isV4Format("192.0.2.1"), true);
  assert.equal(ip.isV4Format("012.1.2.3"), false);

  const ipv4 = ip.toBuffer("192.0.2.1");
  assert.deepEqual([...ipv4], [192, 0, 2, 1]);
  assert.equal(ip.toString(ipv4), "192.0.2.1");
  const ipv6 = ip.toBuffer("2001:db8::1");
  assert.equal(ipv6.byteLength, 16);
  assert.equal(ip.toString(ipv6), "2001:db8::1");

  const target = Buffer.alloc(20);
  assert.equal(ip.toBuffer("192.0.2.1", target, 8), target);
  assert.equal(ip.toString(target, 8, 4), "192.0.2.1");
  assert.throws(() => ip.toBuffer("192.0.2.1", Buffer.alloc(3)), /too small/u);
  assert.throws(() => ip.toString(Buffer.alloc(5)), /exactly 4 or 16/u);
});

test("werift resolves the local audited shim and the lock has no vulnerable node-ip package", () => {
  const bridgeRequire = createRequire(resolve("apps/bridge/package.json"));
  const weriftRequire = createRequire(bridgeRequire.resolve("werift"));
  assert.match(weriftRequire.resolve("ip"), /packages[/\\]ip-safe[/\\]index\.cjs$/u);
  const lock = readFileSync(resolve("pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lock, /^\s{2}ip@2\.0\.1:/mu);
});
