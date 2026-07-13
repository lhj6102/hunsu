import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolveWebServerConfig, unwrapConfigResult } from "@hunsu/config";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const hunsuWeb = unwrapConfigResult(resolveWebServerConfig(process.env));
  const apiProxy = {
    target: hunsuWeb.apiProxyTarget,
    changeOrigin: false
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src")
      }
    },
    define: {
      __HUNSU_API_BASE_URL__: JSON.stringify(hunsuWeb.browserApiUrl ?? "")
    },
    server: {
      host: hunsuWeb.web.host,
      port: hunsuWeb.web.port,
      strictPort: hunsuWeb.strictPort,
      allowedHosts: ["hunsu.localhost"],
      proxy: {
        "/api": apiProxy
      }
    }
  };
});
