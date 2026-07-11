import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolveStudioWebServerConfig, unwrapConfigResult } from "@hunsu/config";
import { defineConfig } from "vite";

const hunsuWeb = unwrapConfigResult(resolveStudioWebServerConfig(process.env));
const bridgeProxy = {
  target: hunsuWeb.apiProxyTarget,
  changeOrigin: false
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src")
    }
  },
  define: {
    __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(hunsuWeb.browserBridgeUrl ?? ""),
    __HUNSU_HUB_API_BASE_URL__: JSON.stringify(hunsuWeb.browserHubApiUrl ?? ""),
    __HUNSU_RELAY_API_BASE_URL__: JSON.stringify(hunsuWeb.browserRelayApiUrl ?? "")
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
});
