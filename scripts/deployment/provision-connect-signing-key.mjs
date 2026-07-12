#!/usr/bin/env node
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const [environmentName, repository = "lhj6102/hunsu"] = process.argv.slice(2);
if (environmentName !== "hunsu-preview" && environmentName !== "hunsu-production") {
  throw new Error("Usage: provision-connect-signing-key.mjs <hunsu-preview|hunsu-production> [owner/repository]");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("Repository must use the owner/name form.");
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicExport = publicKey.export({ format: "jwk" });
const privateExport = privateKey.export({ format: "jwk" });
const publicJwk = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: publicExport.x,
  y: publicExport.y
});
const privateJwk = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: privateExport.x,
  y: privateExport.y,
  d: privateExport.d
});
const keyId = `connect-${createHash("sha256").update(publicJwk).digest("base64url").slice(0, 24)}`;

runGh([
  "secret",
  "set",
  "HUNSU_CONNECT_SIGNING_PRIVATE_JWK",
  "--env",
  environmentName,
  "--repo",
  repository
], privateJwk);
runGh([
  "variable",
  "set",
  "HUNSU_CONNECT_SIGNING_PUBLIC_JWK",
  "--env",
  environmentName,
  "--repo",
  repository,
  "--body",
  publicJwk
]);
runGh([
  "variable",
  "set",
  "HUNSU_CONNECT_SIGNING_KEY_ID",
  "--env",
  environmentName,
  "--repo",
  repository,
  "--body",
  keyId
]);

process.stdout.write(`${JSON.stringify({ environment: environmentName, publicJwk, keyId })}\n`);

function runGh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed without changing the source tree.`);
  }
}
