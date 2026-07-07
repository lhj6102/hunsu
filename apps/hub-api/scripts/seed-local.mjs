#!/usr/bin/env node
import { hubSeedPackageManifests } from "@hunsu/protocol-registry";
import { resolveHubCloudflareConfig } from "@hunsu/config/cloudflare";

const configResult = resolveHubCloudflareConfig(process.env);
if (!configResult.ok) {
  console.error(configResult.error.message);
  process.exit(1);
}

const config = configResult.value;
const baseUrl = (process.env.HUNSU_HUB_PUBLIC_API_URL || config.publicHubApiUrl).replace(/\/$/, "");
const token = process.env.HUNSU_HUB_ADMIN_TOKEN?.trim();
const attempts = Number.parseInt(process.env.HUNSU_HUB_SEED_ATTEMPTS ?? "60", 10);
const delayMs = Number.parseInt(process.env.HUNSU_HUB_SEED_DELAY_MS ?? "1000", 10);

if (!token) {
  console.error("Missing HUNSU_HUB_ADMIN_TOKEN; cannot seed Hub packages.");
  process.exit(1);
}

await waitForHubApi(baseUrl, Number.isFinite(attempts) ? attempts : 60, Number.isFinite(delayMs) ? delayMs : 1000);

for (const manifest of hubSeedPackageManifests()) {
  const response = await fetch(`${baseUrl}/api/hub/packages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ manifest, publishedBy: "hub-seed" })
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 409) {
    console.log(`Hub seed already present: ${manifest.kind}/${manifest.key}@${manifest.version}`);
    continue;
  }
  if (!response.ok) {
    throw new Error(`Hub seed failed for ${manifest.kind}/${manifest.key}@${manifest.version}: ${response.status} ${body.error ?? JSON.stringify(body)}`);
  }
  console.log(`Hub seed published: ${body.summary.kind}/${body.summary.key}@${body.summary.version}`);
}

async function waitForHubApi(url, maxAttempts, waitMs) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/hub/packages`);
      if (response.ok) return;
      lastError = new Error(`Hub API returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  throw lastError instanceof Error ? lastError : new Error(`Hub API did not become ready: ${url}`);
}
