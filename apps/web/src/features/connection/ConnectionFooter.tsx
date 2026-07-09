import { CheckCircle2, Download, ExternalLink, WifiOff } from "lucide-react";
import type { BridgeConnectionState } from "@/shared/api/bridgeConnection";
import type { BridgeStatusResponse } from "@/shared/api/bridgeTypes";
import { cn } from "@/lib/utils";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/tooltip";
import { ProviderStatusCard, providerStatusLabel } from "./ProviderStatusCard.js";
import { WorkspaceConnectionList } from "./WorkspaceConnectionList.js";

export function ConnectionFooter({
  collapsed,
  bridgeStatus,
  bridgeStatusState,
  fallbackConnection,
  onOpen
}: {
  collapsed: boolean;
  bridgeStatus?: BridgeStatusResponse;
  bridgeStatusState: "checking" | "online" | "offline";
  fallbackConnection: BridgeConnectionState;
  onOpen: () => void;
}) {
  const connected = bridgeStatusState === "online" && bridgeStatus !== undefined;
  const local = bridgeStatus?.connections.find(connection => connection.mode === "local");
  const remote = bridgeStatus?.connections.find(connection => connection.mode === "remote" && connection.connection.state === "connected");
  const activeBackend = local ?? bridgeStatus?.connections.find(connection => connection.connection.state === "connected") ?? remote;
  const activeProvider = local?.provider ?? bridgeStatus?.provider ?? activeBackend?.provider;
  const hasRemote = bridgeStatus?.connections.some(connection => connection.mode === "remote") === true;
  const providerReady = activeProvider?.ready === true;
  const title = connected
    ? "Local Bridge"
    : fallbackConnection.status === "checking" ? "Hunsu Bridge" : "Hunsu Bridge";
  const subtitle = connected
    ? activeProvider
      ? `${activeBackend?.label ?? "This computer"} · ${activeProvider.label} ${providerStatusLabel(activeProvider).toLowerCase()}`
      : `${activeBackend?.label ?? "This computer"} · Provider unknown`
    : bridgeStatusState === "checking" ? "Checking" : "Not connected";
  const tone = connected ? "connected" : bridgeStatusState === "checking" ? "checking" : "error";
  const Icon = connected ? CheckCircle2 : WifiOff;
  const content = (
    <div className={cn("mt-3 shrink-0", collapsed ? "w-full" : "w-full")}>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-center gap-3 rounded-[8px] border text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
          collapsed ? "size-11 justify-center p-0" : "px-3 py-2",
          tone === "connected" && "border-[color:var(--apple-green)]/28 bg-white/70 text-[color:var(--apple-green)]",
          tone === "checking" && "border-[color:var(--apple-hairline)] bg-white/58 text-muted-foreground",
          tone === "error" && "border-destructive/24 bg-white/70 text-destructive"
        )}
        onClick={onOpen}
        aria-label={`${title} ${subtitle}`}
      >
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-white/72">
          <Icon className="size-4" />
          <span className={cn("absolute right-1 top-1 size-2 rounded-full", connected ? "bg-[color:var(--apple-green)]" : "bg-destructive")} />
        </span>
        {!collapsed ? (
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-semibold leading-4">{title}</span>
            <span className="block truncate text-[10px] leading-4 text-muted-foreground">{subtitle}</span>
          </span>
        ) : null}
      </button>

      {!collapsed && connected && bridgeStatus ? (
        <div className="mt-2 grid gap-2 rounded-[8px] border border-[color:var(--apple-hairline)] bg-white/42 p-2">
          <ProviderStatusCard provider={activeProvider} compact title="Provider" />
          <WorkspaceConnectionList connections={bridgeStatus.connections} compact maxItems={3} />
          {!bridgeStatus.account.signedIn && !hasRemote ? (
            <div className="rounded-[8px] border border-[color:var(--apple-hairline)] bg-white/62 px-2 py-1.5">
              <span className="block text-[11px] font-semibold leading-4">Remote — Sign in to connect remote workspaces</span>
            </div>
          ) : null}
          {!providerReady && activeProvider ? (
            <Button type="button" size="sm" variant="outline" className="h-8 text-[11px]" onClick={event => {
              event.stopPropagation();
              window.location.href = `hunsu://provider/${encodeURIComponent(activeProvider.providerId)}`;
            }}>
              <ExternalLink className="size-3.5" />
              Open Provider Setup
            </Button>
          ) : bridgeStatus.account.signedIn && !hasRemote ? (
            <Button type="button" size="sm" variant="outline" className="h-8 text-[11px]" onClick={event => {
              event.stopPropagation();
              window.location.href = "hunsu://connection/remote";
            }}>
              <ExternalLink className="size-3.5" />
              Enable Remote
            </Button>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" className="h-8 flex-1 text-[11px]" onClick={event => {
              event.stopPropagation();
              window.location.href = "hunsu://add-workspace";
            }}>
              <ExternalLink className="size-3.5" />
              Add workspace
            </Button>
          </div>
        </div>
      ) : !collapsed && !connected ? (
        <div className="mt-2 flex gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 flex-1 text-[11px]" onClick={() => {
            window.location.href = "https://hunsu.app/download/bridge";
          }}>
            <Download className="size-3.5" />
            Install Bridge
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 flex-1 text-[11px]" onClick={() => {
            window.location.href = "hunsu://open";
          }}>
            <ExternalLink className="size-3.5" />
            Open Bridge
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (!collapsed) {
    return content;
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">{`${title} · ${subtitle}`}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
