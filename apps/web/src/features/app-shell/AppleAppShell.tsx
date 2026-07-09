import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Boxes, ChevronLeft, ChevronRight, CircleDot, LayoutDashboard, Network } from "lucide-react";
import { pushStudioPath, studioRoadmapPath } from "@/app/routes";
import { ConnectionCenter } from "@/features/connection/ConnectionCenter";
import { ConnectionFooter } from "@/features/connection/ConnectionFooter";
import { useBridgeStatus } from "@/features/connection/useBridgeStatus";
import { cn } from "@/lib/utils";
import { useBridgeConnection, type BridgeConnectionState } from "@/shared/api/bridgeConnection";
import { useRoadmapRegistry } from "@/shared/api/useStudioData";
import type { RoadmapRegistryEntry, StudioConnectionStatus } from "@/shared/api/bridgeTypes";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";

type AppleAppShellProps = {
  active: "studio" | "hub";
  currentRoadmapId?: string;
  connectionOverride?: BridgeConnectionState;
  children: ReactNode;
};

export function AppleAppShell({ active, currentRoadmapId, connectionOverride, children }: AppleAppShellProps) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 900);
  const [connectionCenterOpen, setConnectionCenterOpen] = useState(false);
  const [remoteConnection, setRemoteConnection] = useState<StudioConnectionStatus | undefined>();
  const registry = useRoadmapRegistry({ enabled: active === "studio" });
  const bridgeConnection = useBridgeConnection({ enabled: active === "studio" && !connectionOverride, intervalMs: 2500 });
  const bridgeStatus = useBridgeStatus({ enabled: active === "studio", intervalMs: 2500 });
  const effectiveBridgeConnection = useMemo<BridgeConnectionState>(() => remoteConnection
    ? {
        status: "online",
        tokenPresent: true,
        connection: remoteConnection,
        version: remoteConnection.version
      }
    : connectionOverride ?? bridgeConnection, [bridgeConnection, connectionOverride, remoteConnection]);
  const showRoadmaps = active === "studio";
  const recentRoadmaps = useMemo(
    () => [...registry.data].sort(compareRoadmapRecency),
    [registry.data]
  );
  const currentRoadmap = useMemo(
    () => registry.data.find(roadmap => roadmap.roadmapId === currentRoadmapId),
    [currentRoadmapId, registry.data]
  );

  return (
    <div
      className="grid min-h-screen bg-[color:var(--apple-canvas-alt)] text-foreground transition-[grid-template-columns] duration-200"
      style={{ gridTemplateColumns: `${collapsed ? 64 : 252}px minmax(0, 1fr)` }}
    >
      <aside
        className={cn(
          "apple-glass sticky top-0 z-40 box-border flex h-screen min-w-0 flex-col overflow-hidden border-y-0 border-l-0 py-4",
          collapsed ? "items-center px-2" : "px-3"
        )}
      >
        <div className={cn("flex min-w-0", collapsed ? "w-full flex-col items-center gap-2" : "w-full items-center gap-2")}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-ink)] text-[13px] font-semibold text-white">
            H
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold leading-5">Hunsu</p>
              <p className="truncate text-[11px] leading-4 text-muted-foreground">Apple Glass Studio</p>
            </div>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-8 border border-transparent", collapsed ? "bg-white/36" : "ml-auto")}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setCollapsed(next => !next)}
          >
            {collapsed ? <ChevronRight /> : <ChevronLeft />}
          </Button>
        </div>

        <nav className={cn("mt-6 grid w-full gap-1", collapsed && "justify-items-center")}>
          <RailNavItem
            collapsed={collapsed}
            active={active === "studio"}
            icon={<LayoutDashboard className="size-4" />}
            label="Studio"
            caption="Projects"
            onClick={() => pushStudioPath("/studio")}
          />
          <RailNavItem
            collapsed={collapsed}
            active={active === "hub"}
            icon={<Boxes className="size-4" />}
            label="Hub"
            caption="Packages"
            onClick={() => pushStudioPath("/hub")}
          />
        </nav>

        {showRoadmaps ? (
          <section className="mt-6 flex min-h-0 w-full flex-1 flex-col overflow-hidden">
            {!collapsed ? (
              <div className="mb-2 flex items-center justify-between gap-2 px-2">
                <p className="text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">Roadmaps</p>
                <Badge variant={registry.status === "live" ? "success" : "outline"} className="px-2 text-[10px]">
                  {registry.status}
                </Badge>
              </div>
            ) : null}
            <ScrollArea className={cn("min-h-0 flex-1", !collapsed && "pr-1")}>
              <div className={cn("grid gap-1", collapsed && "justify-items-center")}>
                {recentRoadmaps.map(roadmap => (
                  <RoadmapRailItem
                    key={roadmap.roadmapId}
                    roadmap={roadmap}
                    collapsed={collapsed}
                    active={roadmap.roadmapId === currentRoadmapId}
                  />
                ))}
                {registry.status !== "connecting" && registry.data.length === 0 ? (
                  <div className={cn("px-2 py-3 text-[12px] leading-5 text-muted-foreground", collapsed && "sr-only")}>
                    No recent Roadmaps.
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </section>
        ) : (
          <div className="min-h-0 flex-1" />
        )}
        <ConnectionFooter
          collapsed={collapsed}
          bridgeStatus={bridgeStatus.data}
          bridgeStatusState={bridgeStatus.status}
          fallbackConnection={effectiveBridgeConnection}
          onOpen={() => setConnectionCenterOpen(true)}
        />
        <ConnectionCenter
          open={connectionCenterOpen}
          onOpenChange={setConnectionCenterOpen}
          connection={effectiveBridgeConnection}
          currentRoadmap={currentRoadmap}
          onRefresh={() => {
            setRemoteConnection(undefined);
            window.location.reload();
          }}
          onRemoteConnected={setRemoteConnection}
        />
      </aside>
      <div className="min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

function compareRoadmapRecency(left: RoadmapRegistryEntry, right: RoadmapRegistryEntry): number {
  const rightTime = Date.parse(right.lastOpenedAt);
  const leftTime = Date.parse(left.lastOpenedAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(rightTime) !== Number.isFinite(leftTime)) {
    return Number.isFinite(rightTime) ? 1 : -1;
  }
  return right.displayName.localeCompare(left.displayName);
}

function RailNavItem({
  collapsed,
  active,
  icon,
  label,
  caption,
  onClick
}: {
  collapsed: boolean;
  active: boolean;
  icon: ReactNode;
  label: string;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "relative flex min-w-0 items-center gap-3 rounded-[14px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        collapsed ? "size-11 justify-center px-0" : "min-h-11 w-full px-2",
        active ? "text-foreground" : "text-[color:var(--apple-body)] hover:bg-white/42"
      )}
      onClick={onClick}
      title={collapsed ? label : undefined}
    >
      {active ? <span className={cn("absolute rounded-full bg-[color:var(--apple-blue)]", collapsed ? "left-0 h-5 w-0.5" : "left-0 h-6 w-0.5")} /> : null}
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", active ? "bg-[color:var(--apple-blue)] text-white shadow-[0_4px_12px_rgba(0,102,204,0.24)]" : "text-muted-foreground")}>
        {icon}
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold leading-4">{label}</span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">{caption}</span>
        </span>
      ) : null}
    </button>
  );
}

function RoadmapRailItem({
  roadmap,
  collapsed,
  active
}: {
  roadmap: RoadmapRegistryEntry;
  collapsed: boolean;
  active: boolean;
}) {
  const date = new Date(roadmap.lastOpenedAt);
  const validDate = Number.isFinite(date.getTime());
  const canOpen = (roadmap.primaryAction ?? (roadmap.health === "ok" ? "open" : "remove")) === "open";
  return (
    <button
      type="button"
      className={cn(
        "relative flex min-w-0 items-center gap-3 rounded-[14px] text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        collapsed ? "size-10 justify-center px-0" : "min-h-11 w-full px-2",
        active ? "text-foreground" : "text-[color:var(--apple-body)]",
        canOpen ? "hover:bg-white/42" : "cursor-default opacity-72"
      )}
      style={{ "--roadmap-dot": roadmap.health === "ok" ? "var(--apple-green)" : "var(--apple-orange)" } as CSSProperties}
      title={collapsed ? roadmap.displayName : undefined}
      onClick={() => {
        if (canOpen) {
          pushStudioPath(studioRoadmapPath(roadmap.roadmapId));
        }
      }}
    >
      {active ? <span className={cn("absolute rounded-full bg-[color:var(--roadmap-dot)]", collapsed ? "left-0 h-5 w-0.5" : "left-0 h-6 w-0.5")} /> : null}
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[color:var(--roadmap-dot)]", active && "bg-white/54")}>
        {roadmap.health === "ok" ? <CircleDot className="size-3.5 fill-current" /> : <Network className="size-3.5" />}
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-semibold leading-4">{roadmap.displayName}</span>
          <span className="block truncate text-[10px] leading-4 text-muted-foreground">
            {canOpen ? roadmap.lastKnownBranch ?? "branch unknown" : roadmap.primaryAction ?? roadmap.health}{validDate ? ` · ${date.toLocaleDateString()}` : ""}
          </span>
        </span>
      ) : null}
    </button>
  );
}
