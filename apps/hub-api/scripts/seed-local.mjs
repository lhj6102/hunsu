#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeManifestIntegrity,
  hubSeedPackageManifests
} from "@hunsu/protocol-registry";
import { resolveHubCloudflareConfig } from "@hunsu/config/cloudflare";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([401, 408, 425, 429]);

export async function seedHubPackages({
  baseUrl,
  token,
  manifests,
  attempts,
  delayMs,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = console.log
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const maxAttempts = requirePositiveInteger(attempts, "attempts");
  const waitMs = requireNonNegativeInteger(delayMs, "delayMs");
  const adminToken = requireToken(token);

  for (const manifest of manifests) {
    const outcome = await publishSeedManifest({
      baseUrl: normalizedBaseUrl,
      token: adminToken,
      manifest,
      attempts: maxAttempts,
      delayMs: waitMs,
      fetchImpl,
      sleep
    });
    const identity = redactToken(manifestIdentity(manifest), adminToken);
    log(outcome === "published" ? `Hub seed published: ${identity}` : `Hub seed already present: ${identity}`);
  }
}

export async function publishSeedManifest({
  baseUrl,
  token,
  manifest,
  attempts,
  delayMs,
  fetchImpl = fetch,
  sleep = defaultSleep
}) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const maxAttempts = requirePositiveInteger(attempts, "attempts");
  const waitMs = requireNonNegativeInteger(delayMs, "delayMs");
  const adminToken = requireToken(token);
  const identity = redactToken(manifestIdentity(manifest), adminToken);
  const requestedIntegrity = computeManifestIntegrity(manifest);
  const requestUrl = `${normalizedBaseUrl}/api/hub/packages`;
  const requestHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${adminToken}`
  };
  const requestBody = JSON.stringify({ manifest, publishedBy: "hub-seed" });
  let lastRetryableFailure = "unknown transient failure";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: requestBody
      });
    } catch (error) {
      lastRetryableFailure = `network error: ${safeErrorMessage(error, adminToken)}`;
      if (attempt < maxAttempts) {
        await sleep(waitMs);
        continue;
      }
      break;
    }

    const body = await readJsonBody(response);
    if (response.status === 201) {
      return "published";
    }
    if (response.status === 409) {
      const verification = await verifyImmutableManifest({
        baseUrl: normalizedBaseUrl,
        manifest,
        requestedIntegrity,
        token: adminToken,
        fetchImpl
      });
      if (verification.ok) {
        return "already-present";
      }
      if (!verification.retryable) {
        throw new Error(`Hub seed conflict verification failed for ${identity}: ${verification.message}`);
      }
      lastRetryableFailure = verification.message;
      if (attempt < maxAttempts) {
        await sleep(waitMs);
        continue;
      }
      break;
    }
    if (isRetryableStatus(response.status)) {
      lastRetryableFailure = responseFailure(response.status, body, adminToken);
      if (attempt < maxAttempts) {
        await sleep(waitMs);
        continue;
      }
      break;
    }

    throw new Error(`Hub seed failed for ${identity}: ${responseFailure(response.status, body, adminToken)}`);
  }

  throw new Error(`Hub seed failed for ${identity} after ${maxAttempts} attempts: ${lastRetryableFailure}`);
}

export async function waitForHubApi(url, maxAttempts, waitMs, fetchImpl = fetch, sleep = defaultSleep) {
  const attempts = requirePositiveInteger(maxAttempts, "maxAttempts");
  const delayMs = requireNonNegativeInteger(waitMs, "waitMs");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${url}/api/hub/packages`);
      if (response.ok) return;
      lastError = new Error(`Hub API returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Hub API did not become ready: ${url}`);
}

async function verifyImmutableManifest({ baseUrl, manifest, requestedIntegrity, token, fetchImpl }) {
  const identity = redactToken(manifestIdentity(manifest), token);
  const url = `${baseUrl}/v1/packages/${encodeURIComponent(manifest.kind)}/${encodeURIComponent(manifest.key)}/versions/${encodeURIComponent(manifest.version)}`;
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      message: `immutable manifest lookup for ${identity} had a network error: ${safeErrorMessage(error, token)}`
    };
  }
  if (!response.ok) {
    const body = await readJsonBody(response);
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      message: `immutable manifest lookup for ${identity} failed: ${responseFailure(response.status, body, token)}`
    };
  }

  let storedManifest;
  let storedIntegrity;
  try {
    storedManifest = await response.json();
    storedIntegrity = computeManifestIntegrity(storedManifest);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      message: `immutable manifest for ${identity} is invalid: ${safeErrorMessage(error, token)}`
    };
  }
  if (storedManifest?.integrity !== requestedIntegrity || storedIntegrity !== requestedIntegrity) {
    return {
      ok: false,
      retryable: false,
      message: `immutable manifest integrity mismatch: expected ${requestedIntegrity}, declared ${String(storedManifest?.integrity)}, computed ${storedIntegrity}`
    };
  }
  return { ok: true };
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

async function readJsonBody(response) {
  return response.json().catch(() => ({}));
}

function responseFailure(status, body, token) {
  const detail = typeof body?.error === "string"
    ? body.error
    : Object.keys(body ?? {}).length > 0
      ? JSON.stringify(body)
      : "no response body";
  return `${status} ${redactToken(detail, token)}`;
}

function safeErrorMessage(error, token) {
  return redactToken(error instanceof Error ? error.message : String(error), token);
}

function redactToken(value, token) {
  return String(value).split(token).join("[REDACTED]");
}

function manifestIdentity(manifest) {
  return `${manifest.kind}/${manifest.key}@${manifest.version}`;
}

function requireToken(token) {
  const value = token?.trim();
  if (!value) {
    throw new Error("Missing HUNSU_HUB_ADMIN_TOKEN; cannot seed Hub packages.");
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function defaultSleep(delayMs) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, delayMs));
}

async function main() {
  const configResult = resolveHubCloudflareConfig(process.env);
  if (!configResult.ok) {
    throw new Error(configResult.error.message);
  }

  const config = configResult.value;
  const baseUrl = (process.env.HUNSU_HUB_PUBLIC_API_URL || config.publicHubApiUrl).replace(/\/$/, "");
  const token = requireToken(process.env.HUNSU_HUB_ADMIN_TOKEN);
  const attempts = parseIntegerEnvironment("HUNSU_HUB_SEED_ATTEMPTS", DEFAULT_ATTEMPTS);
  const delayMs = parseIntegerEnvironment("HUNSU_HUB_SEED_DELAY_MS", DEFAULT_DELAY_MS);

  await waitForHubApi(baseUrl, attempts, delayMs);
  await seedHubPackages({
    baseUrl,
    token,
    manifests: hubSeedPackageManifests(),
    attempts,
    delayMs
  });
}

function parseIntegerEnvironment(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
