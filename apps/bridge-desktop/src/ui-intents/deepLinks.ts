export function normalizeBridgeAppArgv(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (!first?.startsWith("hunsu://")) {
    return argv;
  }
  const url = new URL(first);
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  const pathFromUrl = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const nextArgs: string[] = [];
  switch (action) {
    case "open":
      nextArgs.push("ui-intent", "provider");
      break;
    case "open-project": {
      nextArgs.push("open-project");
      const path = url.searchParams.get("path") ?? (pathFromUrl && pathFromUrl !== "open-project" ? pathFromUrl : undefined);
      if (path) nextArgs.push(path);
      break;
    }
    case "pair":
      if (url.searchParams.has("code") && url.searchParams.has("state")) {
        nextArgs.push("auth-callback", "--code", url.searchParams.get("code") ?? "", "--state", url.searchParams.get("state") ?? "");
      } else {
        nextArgs.push("pair");
        if (url.searchParams.has("next")) nextArgs.push("--next", url.searchParams.get("next") ?? "/studio");
      }
      break;
    case "open-roadmap":
      if (!url.searchParams.get("roadmapId")) {
        nextArgs.push("protocol-error", "hunsu://open-roadmap requires roadmapId.");
        break;
      }
      nextArgs.push("open-roadmap", url.searchParams.get("roadmapId") ?? "");
      break;
    case "open-workspace":
      if (!url.searchParams.get("workspaceId")) {
        nextArgs.push("protocol-error", "hunsu://open-workspace requires workspaceId.");
        break;
      }
      nextArgs.push("open-roadmap", url.searchParams.get("workspaceId") ?? "");
      break;
    case "add-workspace":
    case "add-roadmap":
      if (url.searchParams.has("path")) {
        const path = url.searchParams.get("path") ?? "";
        if (!path) {
          nextArgs.push("protocol-error", `hunsu://${action} path is empty.`);
          break;
        }
        nextArgs.push("roadmaps", "add", path);
      } else {
        nextArgs.push("ui-intent", "workspaces", "add-workspace");
      }
      break;
    case "workspaces":
    case "roadmaps":
      nextArgs.push("ui-intent", "workspaces");
      break;
    case "codex":
      nextArgs.push("ui-intent", "provider", "codex");
      break;
    case "provider":
      if (pathFromUrl && pathFromUrl !== "codex") {
        nextArgs.push("protocol-error", "Unsupported hunsu://provider path.");
        break;
      }
      nextArgs.push("ui-intent", "provider");
      if (pathFromUrl === "codex") nextArgs.push("codex");
      break;
    case "prerequisites":
      if (pathFromUrl && pathFromUrl !== "codex") {
        nextArgs.push("protocol-error", "Unsupported hunsu://prerequisites path.");
        break;
      }
      nextArgs.push("ui-intent", "provider");
      if (pathFromUrl === "codex") nextArgs.push("codex");
      break;
    case "connection":
      if (pathFromUrl && pathFromUrl !== "remote") {
        nextArgs.push("protocol-error", "Unsupported hunsu://connection path.");
        break;
      }
      nextArgs.push("ui-intent", "connection");
      if (pathFromUrl === "remote") nextArgs.push("remote");
      break;
    case "activate-roadmap":
      if (!url.searchParams.get("roadmapId")) {
        nextArgs.push("protocol-error", "hunsu://activate-roadmap requires roadmapId.");
        break;
      }
      nextArgs.push("activate-roadmap", url.searchParams.get("roadmapId") ?? "");
      break;
    case "remote-disable":
      nextArgs.push("remote", "disable");
      break;
    case "sign-in":
      nextArgs.push("login", "--gui");
      break;
    case "sign-out":
      nextArgs.push("logout");
      break;
    default:
      nextArgs.push("protocol-error", `Unsupported hunsu:// command: ${action || "(empty)"}`);
      break;
  }
  return [...nextArgs, ...rest];
}
