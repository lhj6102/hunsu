import type { ExecutePreflightAction } from "@/shared/api/bridgeTypes";

export function bridgeActionHref(action: ExecutePreflightAction): string {
  if (action.href) return action.href;
  switch (action.type) {
    case "install_codex":
    case "codex_login_chatgpt":
    case "codex_login_device":
    case "codex_recheck":
    case "open_prerequisites":
      return "hunsu://prerequisites/codex";
    case "open_roadmaps":
      return "hunsu://roadmaps";
    case "activate_roadmap":
      return action.roadmapId
        ? `hunsu://activate-roadmap?roadmapId=${encodeURIComponent(action.roadmapId)}`
        : "hunsu://roadmaps";
    case "open_bridge_app":
    default:
      return "hunsu://open";
  }
}
