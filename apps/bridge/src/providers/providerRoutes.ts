import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexRuntimeStatus } from "../runtimes/codex.ts";
import {
  codexRuntimeStatusForResponse,
  spawnCodexAction,
  spawnCodexChatGptLogin,
  spawnCodexDeviceLogin,
  type CodexLoginStateHost
} from "../runtime-providers/codex.ts";
import type { RuntimeProviderConfigurationInput, RuntimeProviderRegistry } from "../runtime-providers/types.ts";

type ProviderRouteContext = {
  providerRegistry: RuntimeProviderRegistry;
  env: Record<string, string | undefined>;
  codexLoginState?: CodexLoginStateHost;
  latestCodexRunUsage?: () => CodexRuntimeStatus["usage"]["lastRunUsage"] | undefined;
  legacyCodexStatus?: () => Promise<unknown>;
  sanitizeLegacyCodexStatus?: (status: unknown) => unknown;
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleProviderRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  url: URL,
  context: ProviderRouteContext
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/providers") {
    const advanced = url.searchParams.get("advanced") === "1" || url.searchParams.get("advanced") === "true";
    const providers = context.providerRegistry.list().filter(provider => advanced || !provider.hiddenByDefault);
    context.sendJson(response, 200, {
      currentProviderId: context.providerRegistry.current().providerId,
      providers: await Promise.all(providers.map(provider => provider.status({ env: context.env })))
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/codex/status" && context.legacyCodexStatus) {
    const status = await context.legacyCodexStatus();
    context.sendJson(response, 200, context.sanitizeLegacyCodexStatus ? context.sanitizeLegacyCodexStatus(status) : status);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/runtimes/codex/status") {
    context.sendJson(response, 200, await codexRuntimeStatusForResponse(context.env, context.codexLoginState ?? {}, {
      lastRunUsage: context.latestCodexRunUsage?.()
    }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/recheck") {
    context.sendJson(response, 202, await codexRuntimeStatusForResponse(context.env, context.codexLoginState ?? {}, {
      force: true,
      lastRunUsage: context.latestCodexRunUsage?.()
    }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/install") {
    const body = await readOptionalJson<{ confirmed?: boolean; dryRun?: boolean }>(request, context.readJson);
    const provider = context.providerRegistry.get("codex") ?? context.providerRegistry.current();
    context.sendJson(response, 202, provider.install
      ? await provider.install({ confirmed: body.confirmed, dryRun: body.dryRun, env: context.env })
      : await provider.installPlan?.());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/login/chatgpt") {
    const provider = context.providerRegistry.get("codex") ?? context.providerRegistry.current();
    context.sendJson(response, 202, provider.login
      ? await provider.login({ method: "chatgpt" })
      : await spawnCodexChatGptLogin(context.codexLoginState ?? {}, context.env));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/login/device") {
    context.sendJson(response, 202, await spawnCodexDeviceLogin(context.codexLoginState ?? {}, context.env));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/login/api-key") {
    const provider = context.providerRegistry.get("codex") ?? context.providerRegistry.current();
    context.sendJson(response, 202, provider.login
      ? await provider.login({ method: "api_key" })
      : await spawnCodexAction(["login", "--api-key"], context.env));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/runtimes/codex/logout") {
    context.sendJson(response, 202, await spawnCodexAction(["logout"], context.env));
    return true;
  }

  if (request.method === "GET" && pathname === "/api/providers/current") {
    context.sendJson(response, 200, await context.providerRegistry.current().status({ env: context.env }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/providers/current/recheck") {
    context.sendJson(response, 202, await context.providerRegistry.current().status({ env: context.env, force: true }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/providers/current/install") {
    const provider = context.providerRegistry.current();
    if (!provider.install) {
      context.sendJson(response, 501, { error: "Current provider does not support installation yet." });
      return true;
    }
    const body = await readOptionalJson<{ confirmed?: boolean; dryRun?: boolean }>(request, context.readJson);
    context.sendJson(response, 202, await provider.install({
      confirmed: body.confirmed,
      dryRun: body.dryRun,
      env: context.env
    }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/providers/current/login") {
    const body = await context.readJson<{ method?: "default" | "chatgpt" | "device" | "api_key" }>(request);
    const provider = context.providerRegistry.current();
    if (!provider.login) {
      context.sendJson(response, 501, { error: "Current provider does not support login yet." });
      return true;
    }
    context.sendJson(response, 202, await provider.login({ method: body.method ?? "default" }));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/providers/current/configure") {
    const body = await context.readJson<RuntimeProviderConfigurationInput>(request);
    const provider = context.providerRegistry.current();
    if (!provider.configure) {
      context.sendJson(response, 501, { error: "Current provider does not support configuration yet." });
      return true;
    }
    context.sendJson(response, 202, await provider.configure({ ...body, env: context.env }));
    return true;
  }

  return false;
}

async function readOptionalJson<T>(
  request: IncomingMessage,
  readJson: <U>(request: IncomingMessage) => Promise<U>
): Promise<Partial<T>> {
  try {
    return await readJson<Partial<T>>(request);
  } catch (_error) {
    return {};
  }
}
