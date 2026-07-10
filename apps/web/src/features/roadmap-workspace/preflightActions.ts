import type { ExecutePreflightAction } from "@/shared/api/bridgeTypes";

export function bridgeActionHref(action: ExecutePreflightAction): string {
  if (action.href) return action.href;
  switch (action.type) {
    case "open_provider_setup":
    case "install_provider":
    case "login_provider":
    case "recheck_provider":
      return action.providerId ? `hunsu://provider/${encodeURIComponent(action.providerId)}` : "hunsu://provider";
    case "open_workspaces":
      return "hunsu://workspaces";
    case "activate_workspace":
      return action.workspaceId
        ? `hunsu://activate-workspace?workspaceId=${encodeURIComponent(action.workspaceId)}`
        : "hunsu://workspaces";
    case "edit_model_alias":
      return "/studio/settings/model-aliases";
    case "open_connection":
      return "hunsu://connection";
    case "open_bridge_app":
    default:
      return "hunsu://open";
  }
}
