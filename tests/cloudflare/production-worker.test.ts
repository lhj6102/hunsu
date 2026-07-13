import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://plugin.hunsu.app";

describe("plugin.hunsu.app Worker", () => {
  it.each(["/", "/projects"])("serves the Hunsu SPA at %s", async path => {
    const response = await fetchWorker(path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>Hunsu Projects</title>");
  });

  it("serves the generated same-origin production runtime overlay", async () => {
    const response = await fetchWorker("/hunsu-runtime-config.js");
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(source).toMatch(/schema\s*:\s*"hunsu\.web-runtime-config\.v3"/u);
    expect(source).toMatch(/target\s*:\s*"production"/u);
    expect(source).toMatch(new RegExp(`sourceSha\\s*:\\s*"${env.TEST_SOURCE_SHA}"`, "u"));
    expect(source).toMatch(/apiBaseUrl\s*:\s*""/u);
  });

  it("returns the anonymous Web session contract as JSON", async () => {
    const response = await fetchWorker("/api/session");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      authenticated: false,
      github: {
        connected: false,
        connectUrl: "/api/auth/github"
      }
    });
  });

  it("publishes same-origin OAuth resource and authorization-server metadata", async () => {
    const resourceResponse = await fetchWorker("/.well-known/oauth-protected-resource");
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN]
    });

    const serverResponse = await fetchWorker("/.well-known/oauth-authorization-server");
    expect(serverResponse.status).toBe(200);
    expect(await serverResponse.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`
    });
  });

  it("routes OAuth registration through the Worker instead of the SPA", async () => {
    const response = await fetchWorker("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example.test/callback"] })
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      redirect_uris: ["https://client.example.test/callback"],
      token_endpoint_auth_method: "none"
    });
  });

  it("challenges anonymous MCP requests with the production resource metadata", async () => {
    const response = await fetchWorker("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
    );
  });

  it("starts GitHub OAuth with the production callback", async () => {
    const response = await fetchWorker("/api/auth/github?return_to=/");

    expect(response.status).toBe(302);
    const location = new URL(requiredHeader(response, "location"));
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it.each([
    "/api",
    "/apiary",
    "/mcpx",
    "/oauth2/authorize",
    "/.well-knownish/oauth-protected-resource"
  ])("keeps the dynamic-route near miss %s on the SPA asset path", async path => {
    const response = await fetchWorker(path);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<title>Hunsu Projects</title>");
  });
});

function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Expected ${name} response header.`);
  return value;
}
