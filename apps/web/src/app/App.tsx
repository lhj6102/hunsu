import { useEffect, useState } from "react";
import { parseStudioRoute, type StudioRoute } from "@/app/routes";
import { AppleAppShell } from "@/features/app-shell/AppleAppShell";
import { HubScreen } from "@/features/hub/HubScreen";
import { RoadmapWorkspace } from "@/features/roadmap-workspace/RoadmapWorkspace";
import { StudioLauncher } from "@/features/studio-launcher/StudioLauncher";

export function App() {
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(window.location));

  useEffect(() => {
    const handlePopState = () => setRoute(parseStudioRoute(window.location));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (route.kind === "hub") {
    return (
      <AppleAppShell active="hub">
        <HubScreen />
      </AppleAppShell>
    );
  }

  if (route.kind === "roadmap") {
    return (
      <AppleAppShell active="studio" currentRoadmapId={route.roadmapId}>
        <RoadmapWorkspace roadmapId={route.roadmapId} />
      </AppleAppShell>
    );
  }

  if (route.kind === "open") {
    return (
      <AppleAppShell active="studio">
        <StudioLauncher mode="open" initialPath={route.path} initialBrowseToken={route.browseToken} initialRootId={route.rootId} />
      </AppleAppShell>
    );
  }

  if (route.kind === "port") {
    return (
      <AppleAppShell active="studio">
        <StudioLauncher mode="port" initialPath={route.path} initialBrowseToken={route.browseToken} initialRootId={route.rootId} />
      </AppleAppShell>
    );
  }

  return (
    <AppleAppShell active="studio">
      <StudioLauncher />
    </AppleAppShell>
  );
}
