import { useEffect, useState } from "react";
import { currentStudioNext, isBridgeBackedStudioRoute, parseStudioRoute, replaceStudioPath, setupPath, type StudioRoute } from "@/app/routes";
import { AppleAppShell } from "@/features/app-shell/AppleAppShell";
import { HubScreen } from "@/features/hub/HubScreen";
import { RoadmapWorkspace } from "@/features/roadmap-workspace/RoadmapWorkspace";
import { SetupScreen } from "@/features/setup/SetupScreen";
import { StudioLauncher } from "@/features/studio-launcher/StudioLauncher";
import { useBridgeConnection } from "@/shared/api/bridgeConnection";
import { hasBridgeApiAuthToken } from "@/shared/api/bridgeApiBase";

export function App() {
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(window.location));
  const routeNeedsBridge = isBridgeBackedStudioRoute(route);
  const hasPairingToken = hasBridgeApiAuthToken();
  const bridge = useBridgeConnection({ enabled: routeNeedsBridge && hasPairingToken });

  useEffect(() => {
    const handlePopState = () => setRoute(parseStudioRoute(window.location));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!routeNeedsBridge) {
      return;
    }
    if (!hasPairingToken || bridge.status === "offline") {
      replaceStudioPath(setupPath(currentStudioNext(window.location)));
    }
  }, [bridge.status, hasPairingToken, routeNeedsBridge]);

  if (route.kind === "setup") {
    return <SetupScreen next={route.next} />;
  }

  if (route.kind === "hub") {
    return (
      <AppleAppShell active="hub">
        <HubScreen />
      </AppleAppShell>
    );
  }

  if (routeNeedsBridge && (!hasPairingToken || bridge.status === "checking" || bridge.status === "offline")) {
    return <SetupScreen next={currentStudioNext(window.location)} />;
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
