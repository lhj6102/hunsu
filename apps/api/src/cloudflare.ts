import type { Env as ConfigEnv } from "@hunsu/config";
import { DurableObjectEphemeralStateStore } from "./auth/cloudflare-ephemeral-store.ts";
import { HunsuEphemeralState } from "./cloudflare/HunsuEphemeralState.ts";
import { createHunsuRuntime } from "./runtime-common.ts";

export { HunsuEphemeralState };

export function isDynamicHunsuRoute(pathname: string): boolean {
  return pathname === "/mcp"
    || pathname.startsWith("/api/")
    || pathname.startsWith("/oauth/")
    || pathname.startsWith("/.well-known/");
}

export function createCloudflareHunsuApp(env: Env, ctx: ExecutionContext) {
  void ctx;
  const stateStore = new DurableObjectEphemeralStateStore({ namespace: env.EPHEMERAL_STATE });
  return createHunsuRuntime(configEnv(env), stateStore).app;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isDynamicHunsuRoute(url.pathname)) {
      const app = createCloudflareHunsuApp(env, ctx);
      return app.handle(request);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

function configEnv(env: Env): ConfigEnv {
  return {
    HUNSU_GITHUB_APP_ID: env.HUNSU_GITHUB_APP_ID,
    HUNSU_GITHUB_CLIENT_ID: env.HUNSU_GITHUB_CLIENT_ID,
    HUNSU_GITHUB_CLIENT_SECRET: env.HUNSU_GITHUB_CLIENT_SECRET,
    HUNSU_GITHUB_PRIVATE_KEY: env.HUNSU_GITHUB_PRIVATE_KEY,
    HUNSU_GITHUB_WEBHOOK_SECRET: env.HUNSU_GITHUB_WEBHOOK_SECRET,
    HUNSU_GITHUB_APP_SLUG: env.HUNSU_GITHUB_APP_SLUG,
    HUNSU_SESSION_SECRET: env.HUNSU_SESSION_SECRET,
    HUNSU_PUBLIC_API_URL: env.HUNSU_PUBLIC_API_URL,
    HUNSU_WEB_URL: env.HUNSU_WEB_URL
  };
}
