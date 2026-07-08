import { useEffect, useState } from "react";
import { currentStudioNext, isBridgeBackedStudioRoute, parseStudioRoute, replaceStudioPath, setupPath, type StudioRoute } from "@/app/routes";
import { AppleAppShell } from "@/features/app-shell/AppleAppShell";
import { HubScreen } from "@/features/hub/HubScreen";
import { RoadmapWorkspace } from "@/features/roadmap-workspace/RoadmapWorkspace";
import { SetupScreen } from "@/features/setup/SetupScreen";
import { StudioLauncher } from "@/features/studio-launcher/StudioLauncher";
import { useBridgeConnection } from "@/shared/api/bridgeConnection";
import { hasBridgeApiAuthToken, hasRemoteBridgeSession } from "@/shared/api/bridgeApiBase";

export function App() {
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(window.location));
  const routeNeedsBridge = isBridgeBackedStudioRoute(route);
  const hasLocalBridgeSession = hasBridgeApiAuthToken();
  const hasRemoteSession = hasRemoteBridgeSession();
  const bridge = useBridgeConnection({ enabled: routeNeedsBridge && hasLocalBridgeSession && !hasRemoteSession });

  useEffect(() => {
    const handlePopState = () => setRoute(parseStudioRoute(window.location));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!routeNeedsBridge) {
      return;
    }
    if (shouldRedirectBridgeBackedStudioRoute({
      routeNeedsBridge,
      hasLocalBridgeSession,
      hasRemoteBridgeSession: hasRemoteSession,
      bridgeStatus: bridge.status
    })) {
      replaceStudioPath(setupPath(currentStudioNext(window.location)));
    }
  }, [bridge.status, hasLocalBridgeSession, hasRemoteSession, routeNeedsBridge]);

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

  if (shouldRenderBridgeBackedSetup({
    routeNeedsBridge,
    hasLocalBridgeSession,
    hasRemoteBridgeSession: hasRemoteSession,
    bridgeStatus: bridge.status
  })) {
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

export function shouldRedirectBridgeBackedStudioRoute(input: {
  routeNeedsBridge: boolean;
  hasLocalBridgeSession: boolean;
  hasRemoteBridgeSession: boolean;
  bridgeStatus: "idle" | "checking" | "online" | "offline";
}): boolean {
  if (!input.routeNeedsBridge || input.hasRemoteBridgeSession) {
    return false;
  }
  return !input.hasLocalBridgeSession || input.bridgeStatus === "offline";
}

export function shouldRenderBridgeBackedSetup(input: {
  routeNeedsBridge: boolean;
  hasLocalBridgeSession: boolean;
  hasRemoteBridgeSession: boolean;
  bridgeStatus: "idle" | "checking" | "online" | "offline";
}): boolean {
  if (!input.routeNeedsBridge || input.hasRemoteBridgeSession) {
    return false;
  }
  return !input.hasLocalBridgeSession || input.bridgeStatus === "checking" || input.bridgeStatus === "offline";
}
