import type { CSSProperties } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import type { DestinationViewState, MoveCardDestinationView, MoveCardView } from "@/shared/domain/roadmapViewModel";

export function MoveCard({
  card,
  selected,
  active,
  executing,
  playable,
  onSelect,
  className
}: {
  card: MoveCardView;
  selected?: boolean;
  active?: boolean;
  executing?: boolean;
  playable?: boolean;
  onSelect?: () => void;
  className?: string;
}) {
  const title = `${card.teamName} M${String(card.ordinal).padStart(4, "0")}`;
  const slots = compactDestinationSlots(card.destinations);
  const fill = moveCardFill(card.progress);

  return (
    <button
      type="button"
      data-figma-component={figmaComponentNames.moveCard}
      data-progress={card.progress}
      data-active={active ? "true" : undefined}
      data-executing={executing ? "true" : undefined}
      data-playable={playable ? "true" : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group relative block h-[104.4px] w-[151.2px] overflow-visible rounded-[10px] border-[1.8px] border-[color:var(--team-color)] text-left text-[color:var(--apple-ink)] shadow-[0_14px_34px_rgba(29,29,31,0.08)] backdrop-blur-xl transition-[filter,transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_18px_42px_rgba(29,29,31,0.12)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_oklab,var(--team-color),transparent_48%)]",
        fill,
        active && "shadow-[0_0_0_3px_color-mix(in_oklab,var(--team-color),transparent_72%),0_18px_42px_rgba(29,29,31,0.12)]",
        executing && "brightness-105",
        playable && "ring-1 ring-[color-mix(in_oklab,var(--team-color),white_30%)]",
        className
      )}
      style={{ "--team-color": card.teamColor } as CSSProperties}
    >
      {selected ? (
        <>
          <span className="pointer-events-none absolute -left-[17px] -top-4 -z-10 h-[136px] w-[185px] rounded-[18px] bg-[color-mix(in_oklab,var(--team-color),transparent_82%)] blur-[12px]" />
          <span className="pointer-events-none absolute -inset-[5px] rounded-[14px] border border-[color-mix(in_oklab,var(--team-color),white_28%)]" />
        </>
      ) : null}
      <span className="absolute left-[12.6px] top-[10.5px] w-28 truncate text-[10px] font-semibold leading-[13px] text-[color:var(--apple-ink)]">
        {title}
      </span>
      <span className="absolute left-[10.8px] top-[28.8px] grid w-[130px] gap-[0.9px]">
        {slots.map((destination, index) => (
          <DestinationSlot
            key={destination?.id ?? `empty-${index}`}
            destination={destination}
            fade={index === 0 && destination?.state === "reached" ? "up" : index === slots.length - 1 ? "down" : undefined}
          />
        ))}
      </span>
    </button>
  );
}

function DestinationSlot({
  destination,
  fade
}: {
  destination?: MoveCardDestinationView;
  fade?: "up" | "down";
}) {
  const state: DestinationViewState | "empty" = destination?.state ?? "empty";
  const completed = state === "reached";
  const blocked = state === "blocked";
  return (
    <span
      className={cn(
        "relative flex h-[9.9px] w-[129.6px] items-center overflow-hidden rounded-[2px] text-[6.7px] leading-[8px]",
        completed
          ? "border-0 bg-[color:var(--studio-destination-completed)] text-white"
          : blocked
            ? "border border-[color:var(--studio-danger)] bg-[color:var(--studio-destination-failed)] text-[color:var(--studio-danger)]"
            : state === "empty"
              ? "border border-[color:var(--studio-destination-pending-stroke)]/55 bg-white/55 text-[color:var(--apple-faint)]"
              : "border border-[color:var(--studio-destination-pending-stroke)] bg-white/82 text-[color:var(--apple-body)]",
        fade === "up" && "opacity-70",
        fade === "down" && "opacity-70"
      )}
    >
      {completed ? <Check className="ml-[5px] size-2 shrink-0" /> : state === "next" ? <ChevronRight className="ml-[4px] size-2 shrink-0" /> : null}
      <span className={cn("truncate", completed || state === "next" ? "ml-px w-[110px]" : "ml-[5px] w-[119px]")}>
        {destination?.title ?? "Destination"}
      </span>
    </span>
  );
}

function moveCardFill(progress: MoveCardView["progress"]): string {
  if (progress === "Arrived") return "bg-[#e8e8ed]/92";
  if (progress === "Executing") return "bg-white/94";
  if (progress === "Accident") return "bg-[#fff1ef]/92";
  return "bg-white/78";
}

function compactDestinationSlots(destinations: MoveCardDestinationView[]): Array<MoveCardDestinationView | undefined> {
  const reached = destinations.filter(destination => destination.state === "reached").slice(-2);
  const left = destinations.filter(destination => destination.state !== "reached").slice(0, 2);
  const slots: Array<MoveCardDestinationView | undefined> = [...reached, ...left];
  return slots.slice(0, 4);
}
