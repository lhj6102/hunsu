import type { CSSProperties } from "react";
import { Check, Clock3, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { InlinePathPoint as InlinePathPointView } from "@/shared/domain/roadmapViewModel";

const pointClass = {
  waiting: "border-border bg-white/76 text-muted-foreground",
  running: "border-[color:var(--team-color)] bg-[color-mix(in_oklab,var(--team-color),white_90%)] text-[color:var(--team-color)]",
  done: "border-[color:var(--studio-success)] bg-[#effaf2] text-[color:var(--studio-success)]",
  failed: "border-[color:var(--studio-danger)] bg-[#fff1ef] text-[color:var(--studio-danger)]"
};

export function InlinePathPoint({
  point,
  selected,
  teamColor,
  onSelect
}: {
  point: InlinePathPointView;
  selected?: boolean;
  teamColor?: string;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      data-figma-component={figmaComponentNames.inlinePathPoint}
      data-progress={point.figmaProgress}
      data-semantic-progress={point.progress}
      className={cn(
        "group absolute flex h-9 w-18 items-center gap-2 rounded-full border px-2 text-left text-xs shadow-[0_12px_30px_rgba(29,29,31,0.08)] backdrop-blur-xl transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        pointClass[point.cssState],
        point.kind === "target" && "opacity-80",
        selected && "ring-[3px] ring-[color-mix(in_oklab,var(--team-color),transparent_55%)]"
      )}
      style={{ left: point.x, top: point.y, "--team-color": teamColor ?? "var(--studio-faker)" } as CSSProperties}
      onClick={onSelect}
    >
      <PointIcon kind={point.kind} state={point.cssState} />
      <span className="min-w-0 truncate">{point.kind === "target" ? "Target" : point.executorId}</span>
      <span data-figma-component={figmaComponentNames.pathPointTooltip} role="tooltip" className="pointer-events-none absolute top-11 left-0 z-10 hidden w-56 rounded-[14px] border bg-popover/92 p-3 text-xs text-popover-foreground shadow-[0_18px_44px_rgba(29,29,31,0.12)] backdrop-blur-xl group-hover:block">
        <strong className="block truncate">{point.pathId ?? point.goal}</strong>
        <span className="mt-1 block leading-4 text-muted-foreground">{point.goal}</span>
        {point.commit ? <span className="mt-1 block font-mono">{point.commit}</span> : null}
      </span>
    </button>
  );
}

function PointIcon({ kind, state }: { kind: InlinePathPointView["kind"]; state: InlinePathPointView["cssState"] }) {
  if (state === "done") return <Check className="size-3.5" />;
  if (state === "running") return <Loader2 className="size-3.5 animate-spin" />;
  if (state === "failed") return <X className="size-3.5" />;
  return <Clock3 className="size-3.5" />;
}
