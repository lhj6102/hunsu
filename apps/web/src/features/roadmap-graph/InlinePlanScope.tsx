import type { CSSProperties } from "react";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { InlinePlanScopeView } from "@/shared/domain/roadmapViewModel";

const planNodeTone = {
  waiting: "border-border bg-white/76 text-muted-foreground",
  running: "border-[color:var(--team-color)] bg-[color-mix(in_oklab,var(--team-color),white_90%)] text-[color:var(--team-color)] shadow-[0_0_0_4px_color-mix(in_oklab,var(--team-color),transparent_82%)]",
  done: "border-[color-mix(in_oklab,var(--team-color),transparent_35%)] bg-white/80 text-[color:var(--team-color)]",
  failed: "border-[color:var(--studio-danger)] bg-[#fff1ef] text-[color:var(--studio-danger)]"
};

export function InlinePlanScope({
  scope,
  selected,
  teamColor,
  onSelect
}: {
  scope: InlinePlanScopeView;
  selected?: boolean;
  teamColor?: string;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      data-figma-component={figmaComponentNames.inlinePlanScope}
      data-state={scope.status}
      data-progress={scope.figmaProgress}
      className={cn(
        "group absolute z-10 flex size-[38px] items-center justify-center rounded-[16px] border shadow-[0_12px_30px_rgba(29,29,31,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        planNodeTone[scope.cssState],
        scope.cssState === "running" && "animate-pulse",
        selected && "ring-[3px] ring-[color-mix(in_oklab,var(--team-color),transparent_55%)]"
      )}
      style={{ left: scope.x, top: scope.y, "--team-color": teamColor ?? "var(--studio-faker)" } as CSSProperties}
      onClick={onSelect}
      aria-label={`${scope.label} ${scope.status} for Execute ${scope.executeId}`}
    >
      <Compass className="size-4" />
      <span role="tooltip" className="pointer-events-none absolute left-0 top-11 z-10 hidden w-60 rounded-[14px] border bg-popover/92 p-3 text-xs text-popover-foreground shadow-[0_18px_44px_rgba(29,29,31,0.12)] backdrop-blur-xl group-hover:block">
        <strong className="block truncate">{scope.status === "planning" ? "Planning Member Paths" : "Team Plan"}</strong>
        <span className="mt-1 block leading-4 text-muted-foreground">
          {scope.status === "planning" ? "Building ExecutionPlan." : "ExecutionPlan planning is recorded here."}
        </span>
        {scope.planSession?.providerTurnId ? <span className="mt-1 block font-mono">{scope.planSession.providerTurnId}</span> : null}
      </span>
    </button>
  );
}
