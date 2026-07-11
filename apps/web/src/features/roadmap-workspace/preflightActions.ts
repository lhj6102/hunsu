import type { ExecutePreflightAction } from "@/shared/api/bridgeTypes";

const STUDIO_SETUP_HREF = "/studio/setup?next=%2Fstudio";

export function bridgeActionHref(action: ExecutePreflightAction): string {
  if (action.href?.startsWith("/") && !action.href.startsWith("//")) return action.href;
  switch (action.type) {
    case "open_provider_setup":
    case "install_provider":
    case "login_provider":
    case "recheck_provider":
      return STUDIO_SETUP_HREF;
    case "open_workspaces":
      return "/studio";
    case "activate_workspace":
      return "/studio";
    case "edit_model_alias":
      return "/studio/settings/model-aliases";
    case "open_connection":
      return STUDIO_SETUP_HREF;
    default:
      return STUDIO_SETUP_HREF;
  }
}
