import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolveStudioWebServerConfig, unwrapConfigResult } from "@hunsu/config";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const hunsuWeb = unwrapConfigResult(resolveStudioWebServerConfig(process.env));
  const bridgeProxy = {
    target: hunsuWeb.apiProxyTarget,
    changeOrigin: false
  };
  const includeDevelopmentFallbacks = command === "serve";
  const connectApiBaseUrl = includeDevelopmentFallbacks
    ? developmentConnectApiBaseUrl(process.env.VITE_HUNSU_CONNECT_API_URL)
    : "";

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src")
      }
    },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(includeDevelopmentFallbacks ? hunsuWeb.browserBridgeUrl ?? "" : ""),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify(includeDevelopmentFallbacks ? hunsuWeb.browserHubApiUrl ?? "" : ""),
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify(connectApiBaseUrl)
    },
    server: {
      host: hunsuWeb.web.host,
      port: hunsuWeb.web.port,
      strictPort: hunsuWeb.strictPort,
      allowedHosts: ["hunsu.localhost"],
      proxy: {
        "/api": bridgeProxy,
        "/health": bridgeProxy,
        "/__bridge": {
          ...bridgeProxy,
          rewrite: path => path.replace(/^\/__bridge(?=\/|$)/u, "") || "/"
        }
      }
    }
  };
});

function developmentConnectApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_HUNSU_CONNECT_API_URL must be a credential-free HTTP(S) URL without a query or fragment.");
  }
  return url.toString().replace(/\/$/u, "");
}
