import { useEffect, useState } from "react";
import { currentStudioNext, isBridgeBackedStudioRoute, parseStudioRoute, replaceStudioPath, setupPath, type StudioRoute } from "@/app/routes";
import { AppleAppShell } from "@/features/app-shell/AppleAppShell";
import { HubScreen } from "@/features/hub/HubScreen";
import { RoadmapWorkspace } from "@/features/roadmap-workspace/RoadmapWorkspace";
import { SetupScreen } from "@/features/setup/SetupScreen";
import { StudioLauncher } from "@/features/studio-launcher/StudioLauncher";
import { useBridgeConnection, useVerifiedRemoteBridgeSession, type BridgeConnectionState, type RemoteBridgeSessionState } from "@/shared/api/bridgeConnection";
import { hasBridgeApiAuthToken, hasRemoteBridgeSession } from "@/shared/api/bridgeApiBase";
import { isUsableLocalStudioConnectionStatus } from "@/shared/api/studioConnectionStatus";
import type { StudioConnectionStatus } from "@/shared/api/bridgeTypes";

export function App() {
  const [route, setRoute] = useState<StudioRoute>(() => parseStudioRoute(window.location));
  const routeNeedsBridge = isBridgeBackedStudioRoute(route);
  const hasLocalBridgeSession = hasBridgeApiAuthToken();
  const hasStoredRemoteSession = hasRemoteBridgeSession();
  const remoteSession = useVerifiedRemoteBridgeSession({ enabled: routeNeedsBridge && hasStoredRemoteSession && !hasLocalBridgeSession });
  const hasVerifiedRemoteSession = remoteSession.status === "remote_connected";
  const remoteBridgeConnection = bridgeConnectionFromRemoteSession(remoteSession);
  const bridge = useBridgeConnection({ enabled: routeNeedsBridge && hasLocalBridgeSession && !hasVerifiedRemoteSession });

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
      hasVerifiedRemoteBridgeSession: hasVerifiedRemoteSession,
      remoteStatus: remoteSession.status,
      bridgeStatus: bridge.status,
      bridgeConnection: bridge.status === "online" ? bridge.connection : undefined
    })) {
      replaceStudioPath(setupPath(currentStudioNext(window.location)));
    }
  }, [bridge.status, bridge.status === "online" ? bridge.connection : undefined, hasLocalBridgeSession, hasVerifiedRemoteSession, remoteSession.status, routeNeedsBridge]);

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
    hasVerifiedRemoteBridgeSession: hasVerifiedRemoteSession,
    remoteStatus: remoteSession.status,
    bridgeStatus: bridge.status,
    bridgeConnection: bridge.status === "online" ? bridge.connection : undefined
  })) {
    return <SetupScreen next={currentStudioNext(window.location)} />;
  }

  if (route.kind === "roadmap") {
    return (
      <AppleAppShell active="studio" currentRoadmapId={route.roadmapId} connectionOverride={remoteBridgeConnection}>
        <RoadmapWorkspace roadmapId={route.roadmapId} />
      </AppleAppShell>
    );
  }

  if (route.kind === "open") {
    return (
      <AppleAppShell active="studio" connectionOverride={remoteBridgeConnection}>
        <StudioLauncher mode="open" initialPath={route.path} initialBrowseToken={route.browseToken} initialRootId={route.rootId} />
      </AppleAppShell>
    );
  }

  if (route.kind === "port") {
    return (
      <AppleAppShell active="studio" connectionOverride={remoteBridgeConnection}>
        <StudioLauncher mode="port" initialPath={route.path} initialBrowseToken={route.browseToken} initialRootId={route.rootId} />
      </AppleAppShell>
    );
  }

  return (
    <AppleAppShell active="studio" connectionOverride={remoteBridgeConnection}>
      <StudioLauncher />
    </AppleAppShell>
  );
}

export function shouldRedirectBridgeBackedStudioRoute(input: {
  routeNeedsBridge: boolean;
  hasLocalBridgeSession: boolean;
  hasRemoteBridgeSession?: boolean;
  hasVerifiedRemoteBridgeSession?: boolean;
  remoteStatus?: RemoteBridgeSessionState["status"];
  bridgeStatus: "idle" | "checking" | "online" | "offline";
  bridgeConnection?: StudioConnectionStatus;
}): boolean {
  const hasVerifiedRemoteBridgeSession = input.hasVerifiedRemoteBridgeSession ?? input.hasRemoteBridgeSession ?? false;
  if (!input.routeNeedsBridge || hasVerifiedRemoteBridgeSession || input.remoteStatus === "remote_checking") {
    return false;
  }
  if (!input.hasLocalBridgeSession || input.bridgeStatus === "offline") {
    return true;
  }
  return input.bridgeStatus === "online" && !hasUsableLocalBridgeSession(input);
}

export function shouldRenderBridgeBackedSetup(input: {
  routeNeedsBridge: boolean;
  hasLocalBridgeSession: boolean;
  hasRemoteBridgeSession?: boolean;
  hasVerifiedRemoteBridgeSession?: boolean;
  remoteStatus?: RemoteBridgeSessionState["status"];
  bridgeStatus: "idle" | "checking" | "online" | "offline";
  bridgeConnection?: StudioConnectionStatus;
}): boolean {
  const hasVerifiedRemoteBridgeSession = input.hasVerifiedRemoteBridgeSession ?? input.hasRemoteBridgeSession ?? false;
  if (!input.routeNeedsBridge || hasVerifiedRemoteBridgeSession) {
    return false;
  }
  if (!input.hasLocalBridgeSession || input.bridgeStatus === "checking" || input.bridgeStatus === "offline") {
    return true;
  }
  return input.bridgeStatus === "online" && !hasUsableLocalBridgeSession(input);
}

function hasUsableLocalBridgeSession(input: {
  hasLocalBridgeSession: boolean;
  bridgeStatus: "idle" | "checking" | "online" | "offline";
  bridgeConnection?: StudioConnectionStatus;
}): boolean {
  return input.hasLocalBridgeSession
    && input.bridgeStatus === "online"
    && isUsableLocalStudioConnectionStatus(input.bridgeConnection);
}

function bridgeConnectionFromRemoteSession(remoteSession: RemoteBridgeSessionState): BridgeConnectionState | undefined {
  if (remoteSession.status !== "remote_connected") {
    return undefined;
  }
  return {
    status: "online",
    tokenPresent: true,
    connection: remoteSession.connection,
    version: remoteSession.connection.version
  };
}
