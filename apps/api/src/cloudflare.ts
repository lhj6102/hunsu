import type { Env as ConfigEnv } from "@hunsu/config";
import { DurableObjectEphemeralStateStore } from "./auth/cloudflare-ephemeral-store.ts";
import { HunsuEphemeralState } from "./cloudflare/HunsuEphemeralState.ts";
import { createHunsuRuntime } from "./runtime-common.ts";

export { HunsuEphemeralState };

type IsolateRuntime = {
  configuration: ConfigEnv;
  namespace: Env["EPHEMERAL_STATE"];
  app: ReturnType<typeof createHunsuRuntime>["app"];
};

let isolateRuntime: IsolateRuntime | undefined;

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

function isolateCloudflareHunsuApp(env: Env) {
  const configuration = configEnv(env);
  if (isolateRuntime
    && isolateRuntime.namespace === env.EPHEMERAL_STATE
    && sameConfig(isolateRuntime.configuration, configuration)) {
    return isolateRuntime.app;
  }
  const stateStore = new DurableObjectEphemeralStateStore({ namespace: env.EPHEMERAL_STATE });
  const app = createHunsuRuntime(configuration, stateStore).app;
  isolateRuntime = { configuration, namespace: env.EPHEMERAL_STATE, app };
  return app;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isDynamicHunsuRoute(url.pathname)) {
      const app = isolateCloudflareHunsuApp(env);
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

function sameConfig(left: ConfigEnv, right: ConfigEnv): boolean {
  return left.HUNSU_GITHUB_APP_ID === right.HUNSU_GITHUB_APP_ID
    && left.HUNSU_GITHUB_CLIENT_ID === right.HUNSU_GITHUB_CLIENT_ID
    && left.HUNSU_GITHUB_CLIENT_SECRET === right.HUNSU_GITHUB_CLIENT_SECRET
    && left.HUNSU_GITHUB_PRIVATE_KEY === right.HUNSU_GITHUB_PRIVATE_KEY
    && left.HUNSU_GITHUB_WEBHOOK_SECRET === right.HUNSU_GITHUB_WEBHOOK_SECRET
    && left.HUNSU_GITHUB_APP_SLUG === right.HUNSU_GITHUB_APP_SLUG
    && left.HUNSU_SESSION_SECRET === right.HUNSU_SESSION_SECRET
    && left.HUNSU_PUBLIC_API_URL === right.HUNSU_PUBLIC_API_URL
    && left.HUNSU_WEB_URL === right.HUNSU_WEB_URL;
}
