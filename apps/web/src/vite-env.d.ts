/// <reference types="vite/client" />

declare const __HUNSU_BRIDGE_API_BASE_URL__: string;
declare const __HUNSU_HUB_API_BASE_URL__: string;
declare const __HUNSU_CONNECT_API_BASE_URL__: string;

interface Window {
  __HUNSU_WEB_RUNTIME_CONFIG__?: unknown;
}
