import { CheckCircle2, Clipboard, ExternalLink, Link2, LogIn, LogOut, RefreshCw, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { currentStudioNext, pushStudioPath, setupPath } from "@/app/routes";
import { connectRemoteBridgeDevice, fetchRemoteBridgeDevices, postRemoteBridgeConnect } from "@/shared/api/bridgeClient";
import { clearRemoteBridgeSession, currentRemoteBridgeSession, hasConnectConfigured, hasRemoteBridgeSession } from "@/shared/api/bridgeApiBase";
import type { BridgeConnectionState } from "@/shared/api/bridgeConnection";
import type { BridgeBackendStatus, RemoteBridgeDevice, RoadmapRegistryEntry, StudioConnectionStatus } from "@/shared/api/bridgeTypes";
import { connectAccountLoginUrl, fetchConnectAccountSession, logoutConnectAccountSession, type ConnectAccountUser } from "@/shared/api/connectClient";
import { closeActiveRemotePeer } from "@/shared/api/peerTransport";
import { bridgeSetupCommands } from "@/shared/config/runtimeConfig";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { ProviderStatusCard, providerStatusLabel } from "./ProviderStatusCard.js";
import { useBridgeStatus } from "./useBridgeStatus.js";
import { WorkspaceConnectionList } from "./WorkspaceConnectionList.js";

type ConnectionCenterProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: BridgeConnectionState;
  currentRoadmap?: RoadmapRegistryEntry;
  onRefresh: () => void;
  onRemoteConnected?: (connection: StudioConnectionStatus) => void;
};

type ConnectSessionView =
  | { status: "unavailable" | "checking" | "signed_out" }
  | { status: "signed_in"; user: ConnectAccountUser }
  | { status: "error"; message: string };

type RemoteWorkspace = NonNullable<RemoteBridgeDevice["workspaces"]>[number];

export function ConnectionCenter({ open, onOpenChange, connection, currentRoadmap, onRefresh, onRemoteConnected }: ConnectionCenterProps) {
  const status = connection.status === "online" ? connection.connection : undefined;
  const version = connection.status === "online" ? connection.version : undefined;
  const diagnostics = buildDiagnostics(connection);
  const canFetchBridgeStatus = open && (connection.status !== "offline" || hasRemoteBridgeSession());
  const bridgeModel = useBridgeStatus({ enabled: canFetchBridgeStatus, intervalMs: 3000 });
  const [connectSession, setConnectSession] = useState<ConnectSessionView>(() => hasConnectConfigured()
    ? { status: "checking" }
    : { status: "unavailable" });
  const selectedRemote = currentRemoteBridgeSession();
  const webUserId = connectSession.status === "signed_in"
    ? connectSession.user.email ?? connectSession.user.name ?? connectSession.user.userId
    : status?.account?.webUserId;
  const bridgeUserId = status?.account?.bridgeUserId;
  const [remoteDevices, setRemoteDevices] = useState<RemoteBridgeDevice[]>([]);
  const [establishingDeviceId, setEstablishingDeviceId] = useState<string | undefined>();
  const [connectingSelection, setConnectingSelection] = useState<string | undefined>();
  const [remoteMessage, setRemoteMessage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    if (!open || !hasConnectConfigured()) {
      setRemoteDevices([]);
      setConnectSession(hasConnectConfigured() ? { status: "checking" } : { status: "unavailable" });
      return () => {
        cancelled = true;
      };
    }
    setConnectSession({ status: "checking" });
    fetchConnectAccountSession()
      .then(async session => {
        if (cancelled) return;
        if (!session.authenticated) {
          setConnectSession({ status: "signed_out" });
          setRemoteDevices([]);
          return;
        }
        setConnectSession({ status: "signed_in", user: session.user });
        const devices = await fetchRemoteBridgeDevices();
        if (!cancelled) {
          setRemoteDevices(devices);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setConnectSession({ status: "error", message: error instanceof Error ? error.message : "Connect session is unavailable." });
          setRemoteDevices([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function establishRemoteDevice(device: RemoteBridgeDevice) {
    setEstablishingDeviceId(device.deviceId);
    setRemoteMessage(undefined);
    try {
      const connected = await connectRemoteBridgeDevice(device.deviceId);
      setRemoteDevices(current => current.map(candidate => candidate.deviceId === connected.deviceId ? connected : candidate));
      setRemoteMessage(`Secure peer established with ${connected.deviceName}.`);
    } catch (error) {
      setRemoteMessage(error instanceof Error ? error.message : "Unable to establish the Remote Bridge peer.");
    } finally {
      setEstablishingDeviceId(undefined);
    }
  }

  async function connectRemoteDevice(device: RemoteBridgeDevice, workspace: RemoteWorkspace) {
    const selectionKey = remoteSelectionKey(device.deviceId, workspace.workspaceId);
    setConnectingSelection(selectionKey);
    setRemoteMessage(undefined);
    try {
      const result = await postRemoteBridgeConnect({
        deviceId: device.deviceId,
        workspaceId: workspace.workspaceId,
        workspaceLabel: workspace.displayName
      });
      onRemoteConnected?.(result.connection);
      setRemoteMessage(result.connection.error ?? `Selected ${workspace.displayName}.`);
    } catch (error) {
      setRemoteMessage(error instanceof Error ? error.message : "Unable to connect to Remote Bridge.");
    } finally {
      setConnectingSelection(undefined);
    }
  }

  function signInToConnect() {
    setConnectSession({ status: "checking" });
    setRemoteMessage(undefined);
    window.location.assign(connectAccountLoginUrl());
  }

  async function signOutOfConnect() {
    setRemoteMessage(undefined);
    try {
      await logoutConnectAccountSession();
      closeActiveRemotePeer();
      clearRemoteBridgeSession();
      setRemoteDevices([]);
      setConnectSession({ status: "signed_out" });
      onRefresh();
    } catch (error) {
      setRemoteMessage(error instanceof Error ? error.message : "Unable to sign out of Connect.");
    }
  }

  async function copyDiagnostics() {
    await navigator.clipboard?.writeText(JSON.stringify(diagnostics, null, 2));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connection Center</DialogTitle>
          <DialogDescription>{bridgeModel.data ? "Provider, Connections, and Workspaces" : problemMessage(connection)}</DialogDescription>
        </DialogHeader>

        {bridgeModel.data ? (
          <div className="grid gap-3">
            <BackendProviderList connections={bridgeModel.data.connections} />
            <ConnectionSection title="Connections" rows={bridgeModel.data.connections.map(backend => [
              backend.mode === "local" ? "Local Bridge" : "Remote Bridge",
              `${backend.label} · ${connectionStateLabel(backend.connection.state)} · ${backend.provider.label} ${providerStatusLabel(backend.provider).toLowerCase()}`
            ] as [string, string])} />
            <WorkspaceConnectionList connections={bridgeModel.data.connections} compact={false} maxItems={8} />
          </div>
        ) : null}

        <RemoteBridgeSection
          session={connectSession}
          devices={remoteDevices}
          selectedDeviceId={selectedRemote?.deviceId ?? (status?.mode === "remote" ? status.bridge?.id : undefined)}
          selectedWorkspaceId={selectedRemote?.workspaceId}
          connectingSelection={connectingSelection}
          establishingDeviceId={establishingDeviceId}
          message={remoteMessage}
          onConnect={connectRemoteDevice}
          onEstablish={establishRemoteDevice}
          onSignIn={signInToConnect}
          onSignOut={signOutOfConnect}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => pushStudioPath(setupPath(currentStudioNext(window.location)))}>
            <ExternalLink className="size-4" />
            Bridge setup
          </Button>
          <Button type="button" variant="outline" onClick={() => pushStudioPath(setupPath(currentStudioNext(window.location)))}>
            <ExternalLink className="size-4" />
            Provider Setup
          </Button>
          <Button type="button" variant="outline" onClick={() => pushStudioPath("/studio")}>
            <ExternalLink className="size-4" />
            Workspaces
          </Button>
          <Button type="button" variant="outline" onClick={onRefresh}>
            <RefreshCw className="size-4" />
            Connections
          </Button>
          <Button type="button" variant="outline" onClick={onRefresh}>
            <RefreshCw className="size-4" />
            Reconnect
          </Button>
        </div>

        <details className="rounded-[16px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-[color:var(--apple-ink)]">Advanced</summary>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-3 md:grid-cols-3">
              <ConnectionSection title="Connection mode" rows={[
                ["Mode", connectionModeLabel(connection)],
                ["Transport", status?.transport ?? "unreachable"],
                ["Health", status?.health ?? connection.status]
              ]} />
              <ConnectionSection title="Bridge" rows={[
                ["Name", status?.bridge?.name ?? "Local Bridge"],
                ["Version", status?.bridge?.version ?? version?.bridgeVersion ?? "unknown"],
                ["Protocol", status?.bridge?.protocolVersion ?? version?.protocolVersion ?? "unknown"],
                ["Started at", status?.bridge?.startedAt ? formatDate(status.bridge.startedAt) : "unknown"],
                ["Endpoint", status?.endpoint?.apiUrl ?? status?.endpoint?.connectLabel ?? "unknown"],
                ["Last seen", status?.bridge?.lastSeenAt ? formatDate(status.bridge.lastSeenAt) : "not seen"]
              ]} />
              <ConnectionSection title="Account" rows={[
                ["Web account", webUserId ? formatIdentity(webUserId) : "Signed out"],
                ["Bridge account", bridgeUserId ? formatIdentity(bridgeUserId) : "Signed out or unavailable"],
                ["Relationship", accountRelationshipLabel(status)]
              ]} />
            </div>
            <ConnectionSection
              title={status?.mode === "remote" || selectedRemote ? "Workspace" : "Project"}
              rows={connectionProjectRows(status, currentRoadmap, selectedRemote)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" title="hunsu-bridge login" onClick={() => copyCliCommand("hunsu-bridge login")}>
                <LogIn className="size-4" />
                Copy login command
              </Button>
              <Button type="button" variant="outline" title="hunsu-bridge logout" onClick={() => copyCliCommand("hunsu-bridge logout")}>
                <LogOut className="size-4" />
                Copy logout command
              </Button>
              <Button type="button" variant="outline" title="hunsu-bridge remote disable" onClick={() => copyCliCommand("hunsu-bridge remote disable")}>
                <ShieldAlert className="size-4" />
                Copy Remote disable
              </Button>
              <Button type="button" variant="outline" title="hunsu-bridge open" onClick={() => copyCliCommand("hunsu-bridge open")}>
                <Link2 className="size-4" />
                Copy pairing command
              </Button>
              <Button type="button" variant="outline" onClick={copyDiagnostics}>
                <Clipboard className="size-4" />
                Copy diagnostics
              </Button>
            </div>
            <pre className="overflow-x-auto text-[12px] leading-5 text-muted-foreground">
              <code>{advancedCliCommand()}</code>
            </pre>
          </div>
        </details>
      </DialogContent>
    </Dialog>
  );
}

function BackendProviderList({ connections }: { connections: BridgeBackendStatus[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {connections.map(backend => (
        <ProviderStatusCard
          key={backend.backendId}
          provider={backend.provider}
          title={backend.mode === "local" ? "Local Provider" : `${backend.label} Provider`}
        />
      ))}
    </div>
  );
}

function connectionStateLabel(state: BridgeBackendStatus["connection"]["state"]): string {
  if (state === "connected") return "Connected";
  if (state === "login_required") return "Login required";
  if (state === "signaling_offline") return "Offline";
  if (state === "not_running") return "Not running";
  return "Error";
}

function RemoteBridgeSection({
  session,
  devices,
  selectedDeviceId,
  selectedWorkspaceId,
  connectingSelection,
  establishingDeviceId,
  message,
  onConnect,
  onEstablish,
  onSignIn,
  onSignOut
}: {
  session: ConnectSessionView;
  devices: RemoteBridgeDevice[];
  selectedDeviceId?: string;
  selectedWorkspaceId?: string;
  connectingSelection?: string;
  establishingDeviceId?: string;
  message?: string;
  onConnect: (device: RemoteBridgeDevice, workspace: RemoteWorkspace) => void;
  onEstablish: (device: RemoteBridgeDevice) => void;
  onSignIn: () => void | Promise<void>;
  onSignOut: () => void;
}) {
  return (
    <section className="rounded-[16px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-normal text-muted-foreground">Available Bridges</h3>
        {session.status === "signed_in" ? (
          <Button type="button" size="sm" variant="ghost" onClick={onSignOut}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2">
        {session.status === "unavailable" ? (
          <p className="text-[12px] leading-5 text-muted-foreground">Hunsu Connect is not configured for this Studio deployment.</p>
        ) : session.status === "checking" ? (
          <p className="text-[12px] leading-5 text-muted-foreground">Checking your secure Connect session…</p>
        ) : session.status === "signed_out" ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] leading-5 text-muted-foreground">Sign in through Cloudflare Access to connect a Remote Bridge.</p>
            <Button type="button" size="sm" onClick={onSignIn}>
              <LogIn className="size-4" />
              Sign in
            </Button>
          </div>
        ) : session.status === "error" ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] leading-5 text-muted-foreground">{session.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={onSignIn}>Sign in</Button>
          </div>
        ) : devices.length === 0 ? (
          <p className="text-[12px] leading-5 text-muted-foreground">No Remote Bridges registered for this Bridge account yet.</p>
        ) : devices.map(device => (
          <div key={device.deviceId} className="grid gap-2 rounded-[12px] border border-[color:var(--apple-hairline)] px-3 py-2 text-[12px] leading-5">
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span className="block truncate font-medium text-[color:var(--apple-ink)]">{device.deviceName}</span>
              <span className={device.status === "online" ? "text-[color:var(--apple-green)]" : "text-muted-foreground"}>
                {device.status === "online" ? "Online" : "Offline"}
              </span>
            </span>
            {device.workspaces === undefined ? (
              <div className="flex items-center justify-between gap-3 pl-2">
                <span className="text-muted-foreground">Workspace names stay on Bridge until a peer is authenticated.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={device.status !== "online" || establishingDeviceId !== undefined}
                  onClick={() => onEstablish(device)}
                >
                  {establishingDeviceId === device.deviceId ? "Establishing" : "Establish peer"}
                </Button>
              </div>
            ) : device.workspaces.length > 0 ? device.workspaces.map(workspace => {
              const selectionKey = remoteSelectionKey(device.deviceId, workspace.workspaceId);
              const selected = selectedDeviceId === device.deviceId && selectedWorkspaceId === workspace.workspaceId;
              return (
                <div key={workspace.workspaceId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 pl-2">
                  <span className="min-w-0 truncate text-muted-foreground">{workspace.displayName}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    disabled={device.status !== "online" || connectingSelection !== undefined}
                    onClick={() => onConnect(device, workspace)}
                  >
                    {connectingSelection === selectionKey ? "Connecting" : selected ? "Connected" : "Connect"}
                  </Button>
                </div>
              );
            }) : (
              <p className="pl-2 text-muted-foreground">No shared workspaces reported.</p>
            )}
          </div>
        ))}
      </div>
      {message ? <p className="mt-3 text-[12px] leading-5 text-muted-foreground">{message}</p> : null}
    </section>
  );
}

function ConnectionSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className="rounded-[16px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-normal text-muted-foreground">{title}</h3>
      <dl className="mt-3 grid gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-[12px] leading-5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-[color:var(--apple-ink)]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function connectionCardLabel(connection: BridgeConnectionState): string {
  const status = connection.status === "online" ? connection.connection : undefined;
  const compatibilityLabel = status ? connectionCompatibilityLabel(status) : undefined;
  if (connection.status === "checking") return "Local Bridge · Checking";
  if (connection.status === "offline") return "Bridge not connected";
  if (connection.status === "online" && !connection.tokenPresent) return "Local Bridge · Pairing needed";
  if (compatibilityLabel) return compatibilityLabel;
  if (status?.warnings.includes("version_mismatch")) return "Bridge update needed";
  if (status?.auth === "account_mismatch") return "Account mismatch";
  if (status?.auth === "expired") return "Session expired";
  if (status?.auth === "invalid") return "Pairing needed";
  if (status?.projectAccess === "denied") return "Workspace access denied";
  if (status?.projectAccess === "needs_grant") return "Workspace access needed";
  if (status?.health === "error") return "Bridge error";
  if (status?.mode === "remote" && status.health === "checking") return "Remote Bridge · Reconnecting";
  if (status?.mode === "remote" && status.health === "connected") return "Remote Bridge · Connected";
  if (connection.status === "online" && connection.tokenPresent) return "Local Bridge · Connected";
  return "Bridge not connected";
}

export function connectionCardTone(connection: BridgeConnectionState): "connected" | "warning" | "error" | "checking" {
  const label = connectionCardLabel(connection);
  if (connection.status === "checking") return "checking";
  if (label.includes("Connected")) return "connected";
  if (label.includes("error") || label.includes("not connected")) return "error";
  return "warning";
}

export function connectionCardIcon(connection: BridgeConnectionState) {
  const tone = connectionCardTone(connection);
  if (tone === "connected") return CheckCircle2;
  if (tone === "error") return WifiOff;
  if (tone === "warning") return ShieldAlert;
  return Wifi;
}

function problemMessage(connection: BridgeConnectionState): string {
  const status = connection.status === "online" ? connection.connection : undefined;
  const compatibilityMessage = status ? connectionCompatibilityMessage(status) : undefined;
  if (connection.status === "offline") return "Bridge is not installed, not running, or unreachable on localhost.";
  if (connection.status === "online" && !connection.tokenPresent) return "Bridge is running without a pairing token for this browser tab.";
  if (status?.warnings.includes("origin_not_allowed")) return "Bridge is running, but this Studio origin is not allowed.";
  if (compatibilityMessage) return compatibilityMessage;
  if (status?.warnings.includes("version_mismatch")) return "Bridge version is too old for this Studio session.";
  if (status?.auth === "invalid") return "Bridge rejected this browser pairing token. Run hunsu-bridge open to pair again.";
  if (status?.projectAccess === "denied") return "Bridge is connected, but the selected Workspace does not allow this access.";
  if (status?.projectAccess === "needs_grant") return "Bridge is connected, but this Workspace still needs access.";
  if (status?.transport === "p2p" && status.health !== "connected") return "Remote Bridge is offline or peer signaling is unavailable.";
  if (status?.auth === "account_mismatch") return "The Web account and Bridge account do not match.";
  if (connection.status === "checking") return "Studio is checking the Bridge connection.";
  return "Studio is connected to Bridge.";
}

function connectionCompatibilityLabel(status: StudioConnectionStatus): string | undefined {
  if (!status.compatibility || status.compatibility.compatible) {
    return undefined;
  }
  switch (status.compatibility.reason) {
    case "bridge_update_needed":
      return "Bridge update needed";
    case "studio_update_needed":
      return "Studio update needed";
    case "feature_unavailable":
      return "Feature unavailable on this Bridge version";
  }
}

function connectionCompatibilityMessage(status: StudioConnectionStatus): string | undefined {
  if (!status.compatibility || status.compatibility.compatible) {
    return undefined;
  }
  switch (status.compatibility.reason) {
    case "bridge_update_needed":
      return "Bridge needs an update before this Studio session can use it.";
    case "studio_update_needed":
      return "Studio needs an update before it can use this Bridge.";
    case "feature_unavailable":
      return "This Bridge version does not support a feature Studio needs.";
  }
}

function connectionModeLabel(connection: BridgeConnectionState): string {
  const status = connection.status === "online" ? connection.connection : undefined;
  if (status?.mode === "remote") return "Remote peer";
  if (status?.mode === "local") return "Local direct";
  return "Not connected";
}

function copyCliCommand(command: string): void {
  void navigator.clipboard?.writeText(command);
}

function advancedCliCommand(): string {
  return bridgeSetupCommands();
}

function buildDiagnostics(connection: BridgeConnectionState): unknown {
  return {
    status: connection.status,
    tokenPresent: connection.tokenPresent,
    connection: connection.status === "online" ? connection.connection : undefined,
    version: connection.status === "online" ? connection.version : undefined,
    error: "error" in connection ? connection.error : undefined,
    capturedAt: new Date().toISOString()
  };
}

function connectionProjectRows(
  status: StudioConnectionStatus | undefined,
  currentRoadmap: RoadmapRegistryEntry | undefined,
  remote: ReturnType<typeof currentRemoteBridgeSession>
): Array<[string, string]> {
  if (status?.mode === "remote" || remote) {
    return [
      ["Workspace", remote?.workspaceLabel ?? status?.project?.displayName ?? "None selected"],
      ["Workspace ID", remote?.workspaceId ?? status?.project?.roadmapId ?? "Unknown"],
      ["Grant", status?.projectAccess ?? "not_applicable"],
      ["Warnings", status?.warnings.length ? status.warnings.join(", ") : "None"]
    ];
  }
  return [
    ["Current Roadmap", status?.project?.displayName ?? currentRoadmap?.displayName ?? status?.project?.roadmapId ?? currentRoadmap?.roadmapId ?? "None"],
    ["Repository", status?.project?.repositoryPath ?? currentRoadmap?.repositoryPath ?? "Unknown"],
    ["Grant", status?.projectAccess ?? "not_applicable"],
    ["Warnings", status?.warnings.length ? status.warnings.join(", ") : "None"]
  ];
}

function remoteSelectionKey(deviceId: string, workspaceId?: string): string {
  return workspaceId ? `${deviceId}:${workspaceId}` : deviceId;
}

function formatIdentity(value: string): string {
  return value.includes("@") ? value : value;
}

function accountRelationshipLabel(status: StudioConnectionStatus | undefined): string {
  if (status?.account?.sameUser === true) return "Same account";
  if (status?.account?.sameUser === false || status?.auth === "account_mismatch") return "Account mismatch";
  if (status?.account?.webUserId && status.account.bridgeUserId) return "Unknown";
  if (status?.account?.bridgeUserId) return "Web account unknown";
  return "Unknown";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
