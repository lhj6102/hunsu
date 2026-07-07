import type { CSSProperties } from "react";
import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { RoadmapConnectionView } from "@/shared/domain/roadmapViewModel";

export function FoldedMoveConnector({
  connection,
  onToggle
}: {
  connection: RoadmapConnectionView;
  onToggle: () => void;
}) {
  if (!connection.display.canToggle || !connection.togglePosition) {
    return null;
  }
  const expand = connection.display.toggleIcon === "expand";
  const expanded = connection.display.connectDisplayType === "Expand";
  return (
    <button
      type="button"
      data-figma-component={figmaComponentNames.foldedMoveConnector}
      data-display={connection.display.connectDisplayType}
      className={cn(
        "absolute z-20 flex items-center justify-center rounded-full border bg-white/76 text-[color:var(--team-color)] shadow-[0_12px_30px_rgba(29,29,31,0.08)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        expanded ? "size-[28px] border-[color-mix(in_oklab,var(--team-color),transparent_68%)] bg-[color-mix(in_oklab,var(--team-color),white_94%)] opacity-90" : "size-[34px]"
      )}
      style={{
        left: connection.togglePosition.x,
        top: connection.togglePosition.y,
        "--team-color": connection.color
      } as CSSProperties}
      aria-label={expand ? "Expand MOVE path connection" : "Fold MOVE path connection"}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {expand ? <ChevronsLeftRight className={expanded ? "size-3.5" : "size-4"} /> : <ChevronsRightLeft className={expanded ? "size-3.5" : "size-4"} />}
    </button>
  );
}
