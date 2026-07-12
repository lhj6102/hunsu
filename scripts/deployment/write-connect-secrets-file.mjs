#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "./release-lib.mjs";
import { validateP256PublicJwk } from "./environment-contract.mjs";

export function writeConnectSecretsFile(outputPath, env = process.env) {
  const expectedPublic = JSON.parse(validateP256PublicJwk(requireEnv("HUNSU_CONNECT_SIGNING_PUBLIC_JWK", env)));
  let suppliedPrivate;
  try {
    suppliedPrivate = JSON.parse(requireEnv("HUNSU_CONNECT_SIGNING_PRIVATE_JWK", env));
  } catch {
    throw new Error("HUNSU_CONNECT_SIGNING_PRIVATE_JWK must be valid JSON.");
  }
  if (
    !suppliedPrivate
    || typeof suppliedPrivate !== "object"
    || Array.isArray(suppliedPrivate)
    || suppliedPrivate.kty !== "EC"
    || suppliedPrivate.crv !== "P-256"
    || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedPrivate.x)
    || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedPrivate.y)
    || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedPrivate.d)
  ) {
    throw new Error("HUNSU_CONNECT_SIGNING_PRIVATE_JWK must be one private P-256 JWK.");
  }
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: suppliedPrivate.x,
    y: suppliedPrivate.y,
    d: suppliedPrivate.d
  };
  let derivedPublic;
  try {
    derivedPublic = createPublicKey(createPrivateKey({ key: privateJwk, format: "jwk" })).export({ format: "jwk" });
  } catch {
    throw new Error("HUNSU_CONNECT_SIGNING_PRIVATE_JWK is not a valid P-256 private key.");
  }
  if (derivedPublic.x !== expectedPublic.x || derivedPublic.y !== expectedPublic.y) {
    throw new Error("Connect signing private key does not match HUNSU_CONNECT_SIGNING_PUBLIC_JWK.");
  }
  const absolutePath = resolve(outputPath);
  writeFileSync(absolutePath, `${JSON.stringify({
    HUNSU_CONNECT_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk)
  })}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(absolutePath, 0o600);
  return absolutePath;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    throw new Error("Usage: write-connect-secrets-file.mjs <output-json>");
  }
  writeConnectSecretsFile(outputPath);
  console.log(JSON.stringify({ written: true }));
}
