#!/usr/bin/env node
import { assertDeployTarget, requireEnv, validateBaseUrl } from "./release-lib.mjs";

const target = assertDeployTarget(requireEnv("HUNSU_DEPLOY_TARGET"));
const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
const projectName = requireEnv("HUNSU_WEB_PAGES_PROJECT");
const webPublicUrl = validateBaseUrl(requireEnv("HUNSU_WEB_PUBLIC_URL"), "HUNSU_WEB_PUBLIC_URL");
if (!/^[0-9a-f]{32}$/iu.test(accountId)) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account identifier.");
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/u.test(projectName)) {
  throw new Error("HUNSU_WEB_PAGES_PROJECT is not a valid Cloudflare Pages project name.");
}
const publicUrl = new URL(webPublicUrl);
const expectedHostname = target === "preview" ? "preview.hunsu.app" : "hunsu.app";
if (publicUrl.protocol !== "https:" || publicUrl.hostname !== expectedHostname || publicUrl.pathname !== "/") {
  throw new Error(`${target} Pages custom domain must be exactly https://${expectedHostname}.`);
}
const hostname = publicUrl.hostname;
const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/domains`;
const headers = {
  authorization: `Bearer ${apiToken}`,
  "content-type": "application/json"
};

let domain = await readDomain();
if (!domain) {
  const response = await cloudflareRequest(baseUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ name: hostname })
  }, { allowConflict: true });
  domain = response?.result ?? await readDomain();
  console.log(`Associated ${hostname} with Cloudflare Pages project ${projectName}.`);
} else {
  console.log(`Cloudflare Pages domain ${hostname} is already associated with ${projectName}.`);
}

const deadline = Date.now() + 15 * 60 * 1000;
while (domain?.status !== "active") {
  if (["blocked", "deactivated", "error"].includes(domain?.status)) {
    const detail = domain.error_message || domain.validation_data?.error_message || domain.verification_data?.error_message || "no detail provided";
    throw new Error(`Cloudflare Pages domain ${hostname} entered ${domain.status}: ${detail}`);
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for Cloudflare Pages domain ${hostname} to become active (last status: ${domain?.status ?? "unknown"}).`);
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
  domain = await readDomain();
}
console.log(`Cloudflare Pages domain ${hostname} is active for ${projectName}.`);

async function readDomain() {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(hostname)}`, {
    headers,
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 404) return undefined;
  return (await parseCloudflareResponse(response)).result;
}

async function cloudflareRequest(url, init, { allowConflict = false } = {}) {
  const response = await fetch(url, init);
  if (allowConflict && response.status === 409) return undefined;
  return parseCloudflareResponse(response);
}

async function parseCloudflareResponse(response) {
  const body = await response.json().catch(() => undefined);
  if (!response.ok || body?.success !== true) {
    const messages = [...(body?.errors ?? []), ...(body?.messages ?? [])]
      .map(item => item?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Cloudflare Pages domain API returned HTTP ${response.status}${messages ? `: ${messages}` : ""}.`);
  }
  return body;
}
