import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import { teamToneMap } from "@/shared/design/teamTone";
import type { PathStory, PathStoryCard, PathStoryConnector, PathStoryDestination } from "@/shared/design/pathStories";

const frame = { width: 1180, height: 876 };

export function PathStoryBoard({
  story,
  className,
  projectTitle = "Payment Console Redesign",
  projectPath = "/studio/roadmaps/payment-console",
  executeDestinationLabel,
  detailPanel,
  detailAnchorId,
  onExecute,
  executeBusy = false,
  executeDisabled = false
}: {
  story: PathStory;
  className?: string;
  projectTitle?: string;
  projectPath?: string;
  executeDestinationLabel?: string;
  detailPanel?: ReactNode;
  detailAnchorId?: string;
  onExecute?: () => void;
  executeBusy?: boolean;
  executeDisabled?: boolean;
}) {
  const detailPosition = detailPanel ? detailPanelPosition(story, detailAnchorId) : undefined;

  return (
    <section className={cn("grid min-w-0 gap-3", className)}>
      <div className="studio-scrollbar overflow-auto rounded-lg border border-[color:var(--studio-border-subtle)] bg-[color:var(--studio-canvas-tint)] shadow-sm">
        <div className="relative shrink-0 overflow-hidden rounded-md bg-[#eef3ef]" style={{ width: frame.width, height: frame.height }}>
          <ScenarioHeader story={story} />
          <DashboardShell projectTitle={projectTitle} projectPath={projectPath} />
          <ConnectorLayer story={story} />
          {story.cards.map(card => (
            <PathStoryCardView
              key={card.id}
              card={card}
              executeDestinationLabel={executeDestinationLabel}
              onExecute={onExecute}
              executeBusy={executeBusy}
              executeDisabled={executeDisabled}
            />
          ))}
          {detailPanel && detailPosition ? (
            <div
              data-figma-component={figmaComponentNames.nodeDetailPanel}
              className="absolute z-30 h-[584px] w-[520px] overflow-hidden rounded-md border border-[#c7d1cb] bg-white shadow-[0_24px_72px_rgba(15,23,42,0.18)]"
              style={{ left: detailPosition.x, top: detailPosition.y }}
            >
              {detailPanel}
            </div>
          ) : null}
          <PathStoryLegend story={story} />
        </div>
      </div>
    </section>
  );
}

function ScenarioHeader({ story }: { story: PathStory }) {
  return (
    <div
      data-figma-component={figmaComponentNames.storyCheckpointDock}
      className="absolute left-0 top-0 h-[116px] w-[1180px] border-b border-[color:var(--studio-border-subtle)] bg-[#eef3ef]"
    >
      <div className="absolute left-[72px] top-5 flex h-[76px] w-[540px] items-center rounded-md border border-[#6ec1ab] bg-white px-[18px] shadow-[0_20px_36px_rgba(15,23,42,0.08)]">
        <div className="w-[74px] shrink-0 text-[11px] font-semibold text-[color:var(--studio-commit)]">Step {String(story.number).padStart(2, "0")}</div>
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold leading-[18px]">{story.title}</h2>
          <p className="mt-2 line-clamp-2 text-[11px] leading-[14px] text-muted-foreground">{story.description}</p>
        </div>
      </div>
    </div>
  );
}

function DashboardShell({ projectTitle, projectPath }: { projectTitle: string; projectPath: string }) {
  return (
    <div data-figma-component="StudioV2/DashboardShell" className="absolute left-0 top-[116px] h-[760px] w-[1180px] rounded-t-md border-t border-[#c7d1cb] bg-[#e9f0eb]">
      <div className="absolute left-0 top-0 h-16 w-full border-b border-[#c7d1cb] bg-white">
        <div className="absolute left-6 top-5 text-[16px] font-semibold leading-5">Hunsu Studio</div>
        <div className="absolute left-[150px] top-3.5 max-w-[780px] truncate text-[16px] font-semibold leading-5">{projectTitle}</div>
        <div className="absolute left-[150px] top-9 max-w-[780px] truncate text-[11px] text-muted-foreground">{projectPath}</div>
      </div>
    </div>
  );
}

function ConnectorLayer({ story }: { story: PathStory }) {
  return (
    <svg className="pointer-events-none absolute inset-0" width={frame.width} height={frame.height} viewBox={`0 0 ${frame.width} ${frame.height}`} aria-hidden="true">
      {story.connectors.map(connector => (
        <PathConnector key={connector.id} connector={connector} cards={story.cards} />
      ))}
    </svg>
  );
}

function PathConnector({ connector, cards }: { connector: PathStoryConnector; cards: PathStoryCard[] }) {
  const from = cards.find(card => card.id === connector.fromId);
  const to = cards.find(card => card.id === connector.toId);
  if (!from || !to) return null;

  const fromSize = cardSize(from);
  const toSize = cardSize(to);
  const start = { x: from.x + fromSize.width, y: from.y + fromSize.height / 2 };
  const end = { x: to.x, y: to.y + toSize.height / 2 };
  const color = teamToneMap[connector.team].color;
  const curve = connector.kind === "hunsuFork";
  const path = curve
    ? `M ${start.x + 18} ${start.y + 8} C ${start.x + 60} ${start.y + 8}, ${end.x - 60} ${end.y - 8}, ${end.x - 18} ${end.y - 8}`
    : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;

  return (
    <g data-figma-component={connector.kind === "hunsuFork" ? figmaComponentNames.hunsuForkConnector : connector.kind === "executeCue" ? figmaComponentNames.executeCueConnector : figmaComponentNames.inlinePathEdge}>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={curve ? 2 : 0}
        strokeDasharray={curve ? "4 4" : undefined}
        strokeLinecap="round"
      />
      {!curve ? <DiamondRun start={start} end={end} color={color} progress={connector.progress} /> : null}
    </g>
  );
}

function DiamondRun({
  start,
  end,
  color,
  progress
}: {
  start: { x: number; y: number };
  end: { x: number; y: number };
  color: string;
  progress: PathStoryConnector["progress"];
}) {
  const count = Math.max(3, Math.min(6, Math.floor(Math.hypot(end.x - start.x, end.y - start.y) / 16)));
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / (count + 1);
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    const filled = progress === "done" || (progress === "running" && index < Math.max(1, count - 1));
    return (
      <rect
        key={`${x}-${y}`}
        data-figma-component={figmaComponentNames.inlinePathPoint}
        x={x - 5}
        y={y - 5}
        width="10"
        height="10"
        rx="1"
        transform={`rotate(45 ${x} ${y})`}
        fill={filled ? color : "#eaf3ee"}
        stroke={color}
        strokeWidth="1"
      />
    );
  });
}

function PathStoryCardView({
  card,
  executeDestinationLabel,
  onExecute,
  executeBusy,
  executeDisabled
}: {
  card: PathStoryCard;
  executeDestinationLabel?: string;
  onExecute?: () => void;
  executeBusy: boolean;
  executeDisabled: boolean;
}) {
  if (card.kind === "executing") return <ExecutingCard card={card} />;
  if (card.kind === "executeButton") return <ExecuteButtonCard card={card} executeDestinationLabel={executeDestinationLabel} onExecute={onExecute} executeBusy={executeBusy} executeDisabled={executeDisabled} />;
  if (card.kind === "hunsu") return <HunsuDraftCard card={card} />;
  return <MoveLikeCard card={card} />;
}

function MoveLikeCard({ card }: { card: PathStoryCard }) {
  const tone = teamToneMap[card.team];
  const accident = card.kind === "accident";
  return (
    <article
      data-figma-component={accident ? figmaComponentNames.accidentCard : figmaComponentNames.moveCard}
      className={cn(
        "absolute h-[104px] w-[151px] overflow-hidden rounded border bg-[#121b18] p-[11px_10px] text-white shadow-sm",
        accident && "bg-[#1b1414]"
      )}
      style={{
        left: card.x,
        top: card.y,
        borderColor: tone.color,
        boxShadow: `0 0 0 1px ${tone.color}`
      } as CSSProperties}
    >
      {accident ? <div className="absolute inset-0 opacity-25 [background:repeating-linear-gradient(18deg,transparent_0,transparent_10px,#ef4444_11px,transparent_12px)]" /> : null}
      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[11px] font-semibold leading-[13px]">{card.title}</h3>
          {accident ? <span className="text-[9px] text-[#ff6b6b]">!</span> : card.status === "arrived" ? <span className="text-[11px]" style={{ color: tone.color }}>✓</span> : null}
        </div>
        <div className="mt-2 grid w-[130px] overflow-hidden rounded-[2px] border border-white/10">
          {card.destinations.map((destination, index) => (
            <DestinationRow key={`${destination.label}-${index}`} destination={destination} />
          ))}
        </div>
      </div>
    </article>
  );
}

function DestinationRow({ destination }: { destination: PathStoryDestination }) {
  return (
    <div
      className={cn(
        "flex h-[10px] items-center gap-1 truncate px-1 text-[7px] leading-[10px]",
        destination.state === "current" && "bg-white text-[#18211d]",
        destination.state === "done" && "bg-[#1e2b25] text-white/85",
        destination.state === "waiting" && "bg-[#17221d] text-white/55",
        destination.state === "failed" && "bg-[#5c2024] text-white"
      )}
    >
      {destination.state === "done" ? <span className="text-[6px]">✓</span> : null}
      <span className="truncate">{destination.label}</span>
    </div>
  );
}

function ExecutingCard({ card }: { card: PathStoryCard }) {
  const tone = teamToneMap[card.team];
  return (
    <article
      data-figma-component={figmaComponentNames.executingCard}
      className="absolute h-[74px] w-[139px] rounded border bg-[#e4f5ed] px-3 py-2.5 text-[#16211d] shadow-sm"
      style={{ left: card.x, top: card.y, borderColor: tone.color } as CSSProperties}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-[13px] font-semibold leading-[17px]">{card.title}</h3>
        <span className="mt-0.5 size-[7px] rounded-full" style={{ backgroundColor: tone.color }} />
      </div>
      <p className="mt-1 text-[11px] leading-[14px]" style={{ color: tone.color }}>Executing...</p>
      <p className="mt-1 truncate text-[11px] leading-[11px]">→ {card.digesting}</p>
    </article>
  );
}

function ExecuteButtonCard({
  card,
  executeDestinationLabel,
  onExecute,
  executeBusy,
  executeDisabled
}: {
  card: PathStoryCard;
  executeDestinationLabel?: string;
  onExecute?: () => void;
  executeBusy: boolean;
  executeDisabled: boolean;
}) {
  const disabled = Boolean(onExecute) && (executeBusy || executeDisabled);
  const digesting = executeDestinationLabel ?? card.digesting;
  return (
    <button
      type="button"
      onClick={onExecute}
      disabled={disabled}
      aria-label={`Start Execute for ${digesting ?? card.title}`}
      data-figma-component={figmaComponentNames.executeButton}
      className={cn(
        "absolute h-[38px] w-[114px] rounded bg-[#1597f5] px-2.5 text-left text-white shadow-sm transition-colors hover:bg-[#0f85da] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1597f5]/45",
        disabled && "cursor-not-allowed opacity-60"
      )}
      style={{ left: card.x, top: card.y }}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold leading-[13px]">
        {executeBusy ? <Loader2 className="size-2.5 animate-spin" /> : <span className="size-1.5 rounded-full bg-white/85" />}
        {executeBusy ? "Starting" : card.title}
      </div>
      <div className="mt-0.5 truncate text-[9px] leading-[10px] text-white/90">→ {digesting}</div>
    </button>
  );
}

function HunsuDraftCard({ card }: { card: PathStoryCard }) {
  return (
    <article
      data-figma-component={figmaComponentNames.hunsuCard}
      className="absolute h-[74px] w-[139px] rounded border border-dashed border-[color:var(--studio-galio)] bg-white px-3 py-2 text-[#171717] shadow-sm"
      style={{ left: card.x, top: card.y }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-[12px] font-semibold leading-[14px]">HUNSU</h3>
        <span className="rounded border px-1 py-0.5 text-[8px] leading-none text-muted-foreground">Draft</span>
      </div>
      <p className="mt-1 truncate text-[9px] text-muted-foreground">{card.title}</p>
      <div className="mt-1 grid gap-0.5">
        {card.destinations.slice(0, 2).map(destination => (
          <div key={destination.label} className="truncate rounded border px-1 py-0.5 text-[8px] leading-[10px]">{destination.label}</div>
        ))}
      </div>
    </article>
  );
}

function PathStoryLegend({ story }: { story: PathStory }) {
  return (
    <footer data-figma-component={figmaComponentNames.teamLegendFooter} className="absolute left-[70px] top-[834px] h-[34px] w-[1040px] border-t border-[#c7d1cb]">
      <div className="flex h-full items-center gap-2 pt-1.5">
        <span className="mr-4 text-[11px] text-muted-foreground">Teams</span>
        {story.teams.map(team => {
          const tone = teamToneMap[team.team];
          return (
            <div
              key={team.team}
              className="flex h-6 min-w-[128px] items-center gap-2 rounded-full border bg-white/70 px-3 text-[11px]"
              style={{ borderColor: tone.color, color: tone.color } as CSSProperties}
            >
              <span className="size-1.5 rounded-full" style={{ backgroundColor: tone.color }} />
              <span className="font-medium text-[#17211d]">{team.team}</span>
              <span className={cn("ml-auto", team.state === "accident" && "text-[#e11d48]", team.state === "arrived" && "text-[#16835b]", team.state === "executing" && "text-[#0477ca]")}>{team.state}</span>
              {team.autopilot ? <Badge variant="outline" className="h-4 px-1 text-[9px] leading-none">AUTO</Badge> : null}
            </div>
          );
        })}
      </div>
    </footer>
  );
}

function cardSize(card: PathStoryCard): { width: number; height: number } {
  if (card.kind === "move" || card.kind === "accident") return { width: 151, height: 104 };
  if (card.kind === "executeButton") return { width: 114, height: 38 };
  return { width: 139, height: 74 };
}

function detailPanelPosition(story: PathStory, anchorId: string | undefined): { x: number; y: number } {
  const anchor = story.cards.find(card => card.id === anchorId)
    ?? story.cards.find(card => card.kind === "move" || card.kind === "accident")
    ?? story.cards[0];
  if (!anchor) return { x: 382, y: 260 };

  const anchorSize = cardSize(anchor);
  const siblingExecute = story.cards.find(card =>
    (card.kind === "executeButton" || card.kind === "executing")
    && card.x > anchor.x
    && Math.abs(card.y - anchor.y) < 96
  );
  const siblingSize = siblingExecute ? cardSize(siblingExecute) : undefined;
  const panelWidth = 520;
  const panelHeight = 584;
  const rawX = siblingExecute && siblingSize ? siblingExecute.x + siblingSize.width + 24 : anchor.x + anchorSize.width + 24;
  const rawY = anchor.y - 12;

  return {
    x: Math.min(Math.max(rawX, 24), frame.width - panelWidth - 24),
    y: Math.min(Math.max(rawY, 188), frame.height - panelHeight - 24)
  };
}
