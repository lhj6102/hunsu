import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, GitCommit, MessageCircle, Play, Route, Send, Settings2, Sparkles, UserRound, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { Textarea } from "@/shared/ui/textarea";
import { figmaComponentNames } from "@/shared/design/figmaContracts";
import { formatShortRef, type AgentSessionView, type GraphNodeView, type InspectorModel, type MoveArtifactActionView, type MoveMemberRuntimeView, type MoveSnapshotDestinationView } from "@/shared/domain/roadmapViewModel";
import { AgentChat, type AgentChatMessage } from "@/features/inspector/AgentChat";
import { MoveFileExplorer } from "@/features/inspector/MoveFileExplorer";
import type { StudioEncodedRuntimeFile, StudioExecutionTransition, StudioHunsuDraftDiffArtifact, StudioHunsuDraftRuntimeFileDiff, StudioHunsuDraftSession } from "@/shared/api/localTypes";

type InspectorTab = "details" | "chat" | "files" | "hunsu-change";

export type HunsuDraftPanelControls = {
  draft?: StudioHunsuDraftSession;
  busy?: boolean;
  error?: string;
  diffArtifacts?: Record<string, StudioHunsuDraftDiffArtifact>;
  onStart: () => void;
  onSendMessage: (message: string) => void;
  onLoadDiffArtifact: (draftSessionId: string, diffArtifactId: string) => Promise<StudioHunsuDraftDiffArtifact>;
  onApprove: (diffArtifactId: string, teamName: string) => void;
  onDiscard: () => void;
};

export type ArtifactActionPanelControls = {
  busyActionId?: string;
  error?: string;
  onRun: (actionId: string, moveId?: string) => void;
};

export function NodeDetailPanel({
  inspector,
  roadmapId,
  actions,
  artifactActionControls,
  hunsuDraftControls,
  onClose,
  className
}: {
  inspector: InspectorModel;
  roadmapId?: string;
  actions?: ReactNode;
  artifactActionControls?: ArtifactActionPanelControls;
  hunsuDraftControls?: HunsuDraftPanelControls;
  onClose?: () => void;
  className?: string;
}) {
  const accent = inspector.action.teamColor;
  const dark = false;
  const heading = inspectorHeading(inspector);
  const eyebrow = inspectorEyebrow(inspector);
  const status = inspectorStatus(inspector);
  const detail = inspectorDetailLine(inspector);
  const scrollKey = useMemo(() => inspectorScrollKey(inspector), [inspector]);
  const contentKey = useMemo(() => inspectorContentKey(inspector), [inspector]);
  const tabResetKey = useMemo(() => inspectorTabResetKey(inspector), [inspector]);
  const stickToBottom = inspectorShouldStickToBottom(inspector);
  const hasChatTab = inspectorHasChat(inspector);
  const hasFilesTab = inspectorHasFiles(inspector, roadmapId);
  const hasHunsuChangeTab = inspectorHasHunsuChange(inspector);
  const hasTabs = hasChatTab || hasFilesTab || hasHunsuChangeTab;
  const defaultTab: InspectorTab = "details";
  const [activeTab, setActiveTab] = useState<InspectorTab>(defaultTab);
  const renderedTab = visibleInspectorTab(activeTab, { hasChatTab, hasFilesTab, hasHunsuChangeTab });

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [tabResetKey, defaultTab]);

  return (
    <aside
      data-figma-component={figmaComponentNames.nodeDetailPanel}
      data-state={inspector.state}
      data-theme={dark ? "Dark" : "Light"}
      className={cn(
        "apple-glass-strong flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[22px] px-[22px] py-5 text-[color:var(--apple-ink)]",
        className
      )}
      style={{ "--detail-accent": accent } as CSSProperties}
    >
      <header className="shrink-0">
        <div className="flex min-h-8 items-center justify-between gap-3 text-[11px] font-semibold leading-4">
          <span className="truncate text-[color:var(--detail-accent)]">{eyebrow}</span>
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn("truncate text-right font-medium", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{status}</span>
            {onClose ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close details"
                className={cn("size-8 rounded-full", dark ? "text-[#dbe8df] hover:bg-white/10 hover:text-white" : "text-muted-foreground hover:bg-white/70 hover:text-[color:var(--apple-ink)]")}
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <h2 className="mt-3 line-clamp-2 text-[24px] font-bold leading-[30px] tracking-normal">{heading}</h2>
        <p className={cn("mt-3 line-clamp-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
          {inspectorSummary(inspector)}
        </p>
        {detail ? (
          <p className="mt-3 text-[12px] font-medium leading-4 text-[color:var(--detail-accent)]">
            {detail}
          </p>
        ) : null}
        {hasTabs ? (
          <div className="mt-5 flex gap-7 border-b border-border">
            <InspectorTabButton active={renderedTab === "details"} label="Details" onClick={() => setActiveTab("details")} />
            {hasChatTab ? <InspectorTabButton active={renderedTab === "chat"} label="Chat" onClick={() => setActiveTab("chat")} /> : null}
            {hasHunsuChangeTab ? <InspectorTabButton active={renderedTab === "hunsu-change"} label="HUNSU Change" onClick={() => setActiveTab("hunsu-change")} /> : null}
            {hasFilesTab ? <InspectorTabButton active={renderedTab === "files"} label="Files" onClick={() => setActiveTab("files")} /> : null}
          </div>
        ) : null}
        {!hasTabs ? <Separator className="mt-5 bg-border" /> : null}
      </header>

      <AutoStickScrollArea className="mt-4 min-h-0 flex-1 pr-1" contentKey={`${contentKey}:${renderedTab}`} dark={dark} stickKey={`${scrollKey}:${renderedTab}`} stickToBottom={renderedTab === "chat" && stickToBottom}>
        <div className="min-w-0 max-w-full space-y-5 overflow-x-hidden pb-4">
          {hasChatTab && renderedTab === "chat" ? (
            <ChatTabContent inspector={inspector} dark={dark} hunsuDraftControls={hunsuDraftControls} actions={actions} />
          ) : hasHunsuChangeTab && renderedTab === "hunsu-change" && inspector.kind === "hunsuDraftRoute" ? (
            <HunsuChangeTabContent inspector={inspector} dark={dark} hunsuDraftControls={hunsuDraftControls} />
          ) : hasFilesTab && renderedTab === "files" && inspector.kind === "move" ? (
            <MoveFilesTabContent inspector={inspector} roadmapId={roadmapId} dark={dark} />
          ) : (
            <>
              {inspector.kind === "move" ? <MoveInspector inspector={inspector} dark={dark} actions={actions} artifactActionControls={artifactActionControls} hunsuDraftControls={hunsuDraftControls} /> : null}
              {inspector.kind === "hunsuDraftRoute" ? <HunsuDraftRouteInspector inspector={inspector} dark={dark} controls={hunsuDraftControls} showDraftPanel={false} /> : null}
              {inspector.kind === "execute" ? <ExecuteInspector inspector={inspector} dark={dark} showChat={false} /> : null}
              {inspector.kind === "pathPoint" ? <PathPointInspector inspector={inspector} dark={dark} showChat={false} /> : null}
              {inspector.kind === "hunsu" ? <HunsuInspector inspector={inspector} dark={dark} actions={actions} /> : null}
            </>
          )}
        </div>
      </AutoStickScrollArea>
    </aside>
  );
}

function InspectorTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "-mb-px border-b-2 pb-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
        active
          ? "border-[color:var(--apple-blue)] text-[color:var(--apple-blue)]"
          : "border-transparent text-muted-foreground hover:text-[color:var(--apple-ink)]"
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function AutoStickScrollArea({
  children,
  className,
  contentKey,
  dark,
  stickKey,
  stickToBottom
}: {
  children: ReactNode;
  className?: string;
  contentKey: string;
  dark: boolean;
  stickKey: string;
  stickToBottom: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const nearBottom = isNearScrollBottom(viewport);
      stickyRef.current = nearBottom;
      if (nearBottom) {
        setHasNewMessages(false);
      }
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [stickKey]);

  useEffect(() => {
    stickyRef.current = stickToBottom;
    setHasNewMessages(false);
    const frame = window.requestAnimationFrame(() => {
      if (stickToBottom) {
        scrollToBottom(bottomRef.current, viewportRef.current);
      } else {
        scrollToTop(viewportRef.current);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [stickKey]);

  useEffect(() => {
    if (!stickToBottom) return;
    const frame = window.requestAnimationFrame(() => {
      if (stickyRef.current) {
        scrollToBottom(bottomRef.current, viewportRef.current);
        setHasNewMessages(false);
      } else {
        setHasNewMessages(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentKey, stickToBottom]);

  useEffect(() => {
    if (!stickToBottom) return;
    const content = contentRef.current;
    if (!content) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (stickyRef.current) {
          scrollToBottom(bottomRef.current, viewportRef.current);
          setHasNewMessages(false);
        } else {
          setHasNewMessages(true);
        }
      });
    });
    observer.observe(content);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [stickKey, stickToBottom]);

  return (
    <div className={cn("relative", className)}>
      <ScrollArea
        className="h-full w-full"
        viewportClassName="min-w-0 overflow-x-hidden pr-3 [&>div]:!block [&>div]:!min-w-0 [&>div]:!w-full [&>div]:!max-w-full"
        viewportRef={viewportRef}
      >
        <div ref={contentRef} className="min-w-0 max-w-full">
          {children}
          <div ref={bottomRef} aria-hidden="true" className="h-px w-full" />
        </div>
      </ScrollArea>
      {hasNewMessages ? (
        <button
          type="button"
          className={cn(
            "absolute bottom-2 right-4 rounded-full border px-3 py-1 text-[11px] font-medium shadow-sm",
            dark ? "border-white/10 bg-[#20251f] text-[#f4fbf7]" : "border-[#d9dfda] bg-white text-[#20251f]"
          )}
          onClick={() => {
            scrollToBottom(bottomRef.current, viewportRef.current);
            stickyRef.current = true;
            setHasNewMessages(false);
          }}
        >
          New messages
        </button>
      ) : null}
    </div>
  );
}

function isNearScrollBottom(viewport: HTMLDivElement, threshold = 32): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

function scrollToBottom(anchor: HTMLDivElement | null, viewport: HTMLDivElement | null) {
  if (anchor) {
    anchor.scrollIntoView({ block: "end", inline: "nearest" });
    return;
  }
  if (viewport) {
    viewport.scrollTop = viewport.scrollHeight;
  }
}

function scrollToTop(viewport: HTMLDivElement | null) {
  if (!viewport) return;
  viewport.scrollTop = 0;
}

function ChatTabContent({
  inspector,
  dark,
  hunsuDraftControls,
  actions
}: {
  inspector: InspectorModel;
  dark: boolean;
  hunsuDraftControls?: HunsuDraftPanelControls;
  actions?: ReactNode;
}) {
  if (inspector.kind === "execute") {
    const planMessages = messagesForAgentSession(inspector.planSession, "Team", "TeamPlan has not emitted chat yet.");
    const planStatus = planStatusForExecuteInspector(inspector);
    return (
      <section>
        <SectionHeader dark={dark} label="Agent Chat" title={planSectionTitle(inspector.planSession, inspector.run)} badge={planStatusLabel(planStatus)} />
        <SessionHint dark={dark} session={inspector.planSession} />
        <div className="mt-3">
          <AgentChat session={inspector.planSession?.session} messages={planMessages} theme="Light" />
        </div>
      </section>
    );
  }

  if (inspector.kind === "pathPoint") {
    const point = inspector.point;
    return (
      <section>
        <SectionHeader dark={dark} label="Agent Chat" title={point.pathId ?? point.executorId ?? "Path"} badge={agentSessionBadge(inspector.executionSession, point.cssState)} />
        <p className="mt-2 text-[12px] leading-[18px] text-muted-foreground">{point.goal}</p>
        <SessionHint dark={dark} session={inspector.executionSession} />
        <div className="mt-3">
          <AgentChat session={inspector.executionSession?.session} messages={messagesForAgentSession(inspector.executionSession, point.executorId ?? "Agent", inspector.pathRun?.goal ?? "Member Path has not emitted chat yet.")} theme="Light" />
        </div>
      </section>
    );
  }

  if (inspector.kind === "hunsuDraftRoute") {
    const controlDraft = hunsuDraftForInspector(inspector, hunsuDraftControls);
    return hunsuDraftControls ? (
      <HunsuDraftPanel dark={dark} controls={{ ...hunsuDraftControls, draft: controlDraft }} draftSession={inspector.draftSession} />
    ) : (
      <EmptyChatNotice />
    );
  }

  if (actions) {
    return <section className="grid gap-2">{actions}</section>;
  }

  return <EmptyChatNotice />;
}

function HunsuChangeTabContent({
  inspector,
  dark,
  hunsuDraftControls
}: {
  inspector: Extract<InspectorModel, { kind: "hunsuDraftRoute" }>;
  dark: boolean;
  hunsuDraftControls?: HunsuDraftPanelControls;
}) {
  if (!hunsuDraftControls) {
    return (
      <InspectorSection>
        <h3 className="text-[12px] font-semibold">HUNSU Change</h3>
        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">No HUNSU Draft controls are attached to this route.</p>
      </InspectorSection>
    );
  }
  const controlDraft = hunsuDraftForInspector(inspector, hunsuDraftControls);
  return <HunsuDraftChangePanel dark={dark} controls={{ ...hunsuDraftControls, draft: controlDraft }} draftSession={inspector.draftSession} />;
}

function EmptyChatNotice() {
  return (
    <InspectorSection>
      <h3 className="text-[12px] font-semibold">Agent Chat</h3>
      <p className="mt-2 text-[12px] leading-5 text-muted-foreground">No chat stream is attached to this node yet.</p>
    </InspectorSection>
  );
}

function inspectorHasChat(inspector: InspectorModel): boolean {
  if (inspector.kind === "execute" || inspector.kind === "pathPoint" || inspector.kind === "hunsuDraftRoute") return true;
  return false;
}

function inspectorHasFiles(inspector: InspectorModel, roadmapId: string | undefined): boolean {
  return inspector.kind === "move" && Boolean(roadmapId && inspector.move?.id);
}

function inspectorHasHunsuChange(inspector: InspectorModel): boolean {
  return inspector.kind === "hunsuDraftRoute";
}

function visibleInspectorTab(activeTab: InspectorTab, options: { hasChatTab: boolean; hasFilesTab: boolean; hasHunsuChangeTab: boolean }): InspectorTab {
  if (activeTab === "chat" && !options.hasChatTab) return "details";
  if (activeTab === "files" && !options.hasFilesTab) return "details";
  if (activeTab === "hunsu-change" && !options.hasHunsuChangeTab) return "details";
  return activeTab;
}

function MoveFilesTabContent({ inspector, roadmapId, dark }: { inspector: Extract<InspectorModel, { kind: "move" }>; roadmapId?: string; dark: boolean }) {
  const moveId = inspector.move?.id ? String(inspector.move.id) : undefined;
  return <MoveFileExplorer roadmapId={roadmapId} moveId={moveId} dark={dark} />;
}

function MoveInspector({ inspector, dark, actions, artifactActionControls, hunsuDraftControls, showDraftControls = true }: { inspector: Extract<InspectorModel, { kind: "move" }>; dark: boolean; actions?: ReactNode; artifactActionControls?: ArtifactActionPanelControls; hunsuDraftControls?: HunsuDraftPanelControls; showDraftControls?: boolean }) {
  return (
    <>
      {actions ? (
        <section className="grid gap-2">
          <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>Execute next</p>
          {actions}
        </section>
      ) : null}

      {hunsuDraftControls && showDraftControls ? <HunsuDraftLauncher dark={dark} controls={hunsuDraftControls} /> : null}

      <DestinationSnapshotSection
        dark={dark}
        achieved={inspector.achievedSnapshotDestinations}
        remaining={inspector.remainingSnapshotDestinations}
        all={inspector.snapshotDestinations}
      />

      <TeamRuntimeSection dark={dark} runtime={inspector.teamRuntime} />

      <MemberRuntimeSection dark={dark} members={inspector.memberRuntime} />

      <ArtifactActionsSection
        dark={dark}
        actions={inspector.artifactActions}
        moveId={inspector.move?.id ? String(inspector.move.id) : undefined}
        controls={artifactActionControls}
      />

      {inspector.move?.evidence?.length ? (
        <CompactList dark={dark} title="Evidence" items={inspector.move.evidence.map(String)} />
      ) : null}
      {inspector.move?.risks?.length ? (
        <CompactList dark={dark} title="Risks" items={inspector.move.risks.map(String)} />
      ) : null}
    </>
  );
}

function ArtifactActionsSection({
  dark,
  actions,
  moveId,
  controls
}: {
  dark: boolean;
  actions: MoveArtifactActionView[];
  moveId?: string;
  controls?: ArtifactActionPanelControls;
}) {
  return (
    <InspectorSection>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>Artifact Actions</p>
          <h3 className="mt-1 text-[13px] font-semibold leading-5">{actions.length} configured</h3>
        </div>
      </div>
      {actions.length === 0 ? (
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>No Artifact Actions are configured for this MOVE.</p>
      ) : (
        <div className={cn("mt-3 divide-y", dark ? "divide-white/10" : "divide-[#d9dfda]")}>
          {actions.map(action => (
            <ArtifactActionItem key={action.id} dark={dark} action={action} moveId={moveId} controls={controls} />
          ))}
        </div>
      )}
      {controls?.error ? <p className="mt-2 break-words text-[12px] leading-5 text-[#e11d48]">{controls.error}</p> : null}
    </InspectorSection>
  );
}

function ArtifactActionItem({
  dark,
  action,
  moveId,
  controls
}: {
  dark: boolean;
  action: MoveArtifactActionView;
  moveId?: string;
  controls?: ArtifactActionPanelControls;
}) {
  const busy = controls?.busyActionId === action.id;
  const aliasText = action.aliases
    .map(alias => alias.url ?? alias.service ?? alias.target ?? alias.alias)
    .join(", ");
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-[12px] font-semibold">{action.title}</h4>
          <p className={cn("mt-0.5 truncate text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
            {action.kind} · {action.runnerLabel}
          </p>
        </div>
        <Badge variant={action.latestRun?.status === "failed" ? "destructive" : action.latestRun?.status === "succeeded" ? "success" : action.latestRun?.status === "running" ? "secondary" : "outline"} className="shrink-0">
          {action.latestRun?.status ?? "idle"}
        </Badge>
      </div>
      {aliasText ? (
        <p className={cn("mt-2 truncate text-[11px] leading-4", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{aliasText}</p>
      ) : null}
      {action.latestRun ? (
        <dl className="mt-2 grid gap-1 text-[11px] leading-4">
          <Row dark={dark} label="Run" value={action.latestRun.runId} />
          {action.latestRun.commit ? <Row dark={dark} label="Commit" value={formatShortRef(action.latestRun.commit)} /> : null}
          {action.latestRun.exitCode !== undefined ? <Row dark={dark} label="Exit" value={String(action.latestRun.exitCode)} /> : null}
          {action.latestRun.error ? <Row dark={dark} label="Error" value={action.latestRun.error} /> : null}
        </dl>
      ) : null}
      {controls ? (
        <Button type="button" size="sm" variant="secondary" className="mt-3 w-full justify-start" onClick={() => controls.onRun(action.id, moveId)} disabled={busy}>
          <Play className="mr-2 size-4" />
          {busy ? "Starting" : "Run Action"}
        </Button>
      ) : null}
    </div>
  );
}

function DestinationSnapshotSection({
  dark,
  achieved,
  remaining,
  all
}: {
  dark: boolean;
  achieved: MoveSnapshotDestinationView[];
  remaining: MoveSnapshotDestinationView[];
  all: MoveSnapshotDestinationView[];
}) {
  const closed = all.filter(destination => destination.displayState === "closed");
  return (
    <InspectorSection>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>MOVE Snapshot</p>
          <h3 className="mt-1 text-[13px] font-semibold leading-5">Destination queue</h3>
        </div>
        <Badge variant={remaining.length === 0 ? "success" : "secondary"} className="shrink-0">
          {remaining.length} left
        </Badge>
      </div>

      <div className={cn("mt-3 divide-y", dark ? "divide-white/10" : "divide-[#d9dfda]")}>
        <DestinationGroup dark={dark} title="Achieved" empty="No Destination has been reached in this snapshot." destinations={achieved} />
        <DestinationGroup dark={dark} title="Remaining" empty="No remaining Destination in this snapshot." destinations={remaining} />
        {closed.length > 0 ? <DestinationGroup dark={dark} title="Closed" empty="" destinations={closed} compact /> : null}
      </div>
    </InspectorSection>
  );
}

function DestinationGroup({
  dark,
  title,
  empty,
  destinations,
  compact
}: {
  dark: boolean;
  title: string;
  empty: string;
  destinations: MoveSnapshotDestinationView[];
  compact?: boolean;
}) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <h4 className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{title}</h4>
      {destinations.length === 0 ? (
        <p className={cn("mt-1 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{empty}</p>
      ) : (
        <div className={cn("mt-1 divide-y", dark ? "divide-white/10" : "divide-[#d9dfda]")}>
          {destinations.map(destination => <DestinationSnapshotItem key={destination.id} dark={dark} destination={destination} compact={compact} />)}
        </div>
      )}
    </div>
  );
}

function DestinationSnapshotItem({ dark, destination, compact }: { dark: boolean; destination: MoveSnapshotDestinationView; compact?: boolean }) {
  const detailItems = [
    ...destination.acceptanceCriteria.slice(0, 2).map(item => `AC: ${item}`),
    ...destination.constraints.slice(0, 1).map(item => `Constraint: ${item}`),
    destination.notes ? `Notes: ${destination.notes}` : undefined
  ].filter((item): item is string => Boolean(item));
  return (
    <div className="py-2 text-[12px] leading-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="min-w-0 font-medium">{destination.title}</p>
          <p className={cn("mt-0.5 text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
            {destination.queueHead ? "queue head" : `priority ${destination.priority ?? 1}`}
            {destination.reachedByThisMove ? " · reached by this MOVE" : ""}
          </p>
        </div>
        <Badge variant={destination.displayState === "reached" ? "success" : destination.displayState === "blocked" ? "destructive" : destination.displayState === "closed" ? "secondary" : "outline"} className="shrink-0 capitalize">
          {destination.displayState}
        </Badge>
      </div>
      {!compact && detailItems.length > 0 ? (
        <ul className={cn("mt-2 grid list-disc gap-1 pl-4 text-[11px] leading-4", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
          {detailItems.map(item => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function TeamRuntimeSection({ dark, runtime }: { dark: boolean; runtime: Extract<InspectorModel, { kind: "move" }>["teamRuntime"] }) {
  return (
    <InspectorSection>
      <div className="flex items-center gap-2">
        <Settings2 className="size-4 shrink-0 text-[color:var(--detail-accent)]" />
        <h3 className="text-[12px] font-semibold">Team Runtime</h3>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <RuntimeField dark={dark} label="Harness" value={runtime.harnessLabel} />
        <RuntimeField dark={dark} label="Budget" value={runtime.budgetLabel} />
        <RuntimeField dark={dark} label="Harness kind" value={runtime.harnessKind} />
        <RuntimeField dark={dark} label="Guardrails" value={runtime.guardrailLabel} />
      </div>
      <PromptPreview dark={dark} label="Team prompt" text={runtime.prompt} />
    </InspectorSection>
  );
}

function MemberRuntimeSection({ dark, members }: { dark: boolean; members: MoveMemberRuntimeView[] }) {
  return (
    <InspectorSection>
      <div className="flex items-center gap-2">
        <UserRound className="size-4 shrink-0 text-[color:var(--detail-accent)]" />
        <h3 className="text-[12px] font-semibold">Members</h3>
      </div>
      {members.length === 0 ? (
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>This Team Snapshot has no Members.</p>
      ) : (
        <div className={cn("mt-3 divide-y", dark ? "divide-white/10" : "divide-[#d9dfda]")}>
          {members.map(member => <MemberRuntimeItem key={member.id} dark={dark} member={member} />)}
        </div>
      )}
    </InspectorSection>
  );
}

function MemberRuntimeItem({ dark, member }: { dark: boolean; member: MoveMemberRuntimeView }) {
  return (
    <details className="group py-2.5" open>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <h4 className="truncate text-[12px] font-semibold">{member.id}</h4>
          <p className={cn("mt-0.5 truncate text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{member.modelLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={member.skills.length > 0 ? "secondary" : "outline"}>{member.skills.length} skills</Badge>
          <ChevronDown className={cn("size-3.5 transition-transform group-open:rotate-180", dark ? "text-[#9eb4aa]" : "text-[#626b66]")} />
        </div>
      </summary>
      <dl className="mt-2 grid gap-1 text-[11px] leading-4">
        <Row dark={dark} label="Execution" value={member.executionLabel} />
        <Row dark={dark} label="Approval" value={member.approvalLabel} />
        <Row dark={dark} label="Skills" value={member.skills.join(", ") || "none"} />
      </dl>
      <PromptPreview dark={dark} label="Member prompt" text={member.prompt} compact />
    </details>
  );
}

function RuntimeField({ dark, label, value }: { dark: boolean; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className={cn("text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{label}</p>
      <p className="mt-0.5 truncate text-[11px] font-medium leading-4">{value}</p>
    </div>
  );
}

function PromptPreview({ dark, label, text, compact }: { dark: boolean; label: string; text: string; compact?: boolean }) {
  return (
    <div className={cn("mt-3 border-l pl-3", dark ? "border-white/15" : "border-[#d9dfda]")}>
      <p className={cn("text-[10px] font-semibold leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{label}</p>
      <p className={cn("mt-1 text-[11px] leading-4", compact ? "line-clamp-2" : "line-clamp-3", dark ? "text-[#dbe8df]" : "text-[#3c4640]")}>
        {text || "No prompt recorded."}
      </p>
    </div>
  );
}

function HunsuDraftLauncher({ dark, controls }: { dark: boolean; controls: HunsuDraftPanelControls }) {
  return (
    <InspectorSection>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle className="size-4 shrink-0 text-[color:var(--studio-galio)]" />
          <h3 className="truncate text-[12px] font-semibold">HUNSU Draft Route</h3>
        </div>
      </div>
      <Button type="button" size="sm" className="mt-3 w-full" onClick={controls.onStart} disabled={controls.busy}>
        <Sparkles className="mr-2 size-4" />
        Start Hunsu Draft
      </Button>
      {controls.error ? <p className="mt-2 break-words text-[12px] leading-5 text-[#e11d48]">{controls.error}</p> : null}
    </InspectorSection>
  );
}

function HunsuDraftRouteInspector({ inspector, dark, controls, showDraftPanel = true }: { inspector: Extract<InspectorModel, { kind: "hunsuDraftRoute" }>; dark: boolean; controls?: HunsuDraftPanelControls; showDraftPanel?: boolean }) {
  const controlDraft = hunsuDraftForInspector(inspector, controls);
  return (
    <>
      <section>
        <SectionHeader dark={dark} label="HUNSU Draft Route" title={inspector.route.label} badge={inspector.draft.status} />
        <p className={cn("mt-2 text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
          Source {inspector.sourceNode.card.teamName} M{String(inspector.sourceNode.card.ordinal).padStart(4, "0")}
        </p>
      </section>
      {controls && showDraftPanel ? <HunsuDraftPanel dark={dark} controls={{ ...controls, draft: controlDraft }} draftSession={inspector.draftSession} /> : null}
    </>
  );
}

function hunsuDraftForInspector(inspector: Extract<InspectorModel, { kind: "hunsuDraftRoute" }>, controls?: HunsuDraftPanelControls): StudioHunsuDraftSession {
  return controls?.draft?.draftSessionId === inspector.draft.draftSessionId ? controls.draft : inspector.draft;
}

function HunsuDraftPanel({ dark, controls, draftSession }: { dark: boolean; controls: HunsuDraftPanelControls; draftSession?: AgentSessionView }) {
  const [message, setMessage] = useState("");
  const draft = controls.draft;
  const busy = controls.busy === true;
  const messages = draft ? hunsuDraftMessages(draft, draftSession) : [];

  return (
    <InspectorSection>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle className="size-4 shrink-0 text-[color:var(--studio-galio)]" />
          <h3 className="truncate text-[12px] font-semibold">HUNSU Draft</h3>
        </div>
        <Badge variant={draft?.status === "failed" ? "destructive" : draft?.status === "ready" ? "success" : "secondary"} className="shrink-0">
          {draft?.status ?? "idle"}
        </Badge>
      </div>

      {!draft ? (
        <Button type="button" size="sm" className="mt-3 w-full" onClick={controls.onStart} disabled={busy}>
          <Sparkles className="mr-2 size-4" />
          Start Hunsu Draft
        </Button>
      ) : (
        <div className="mt-3 grid gap-3">
          <AgentChat messages={messages} theme={dark ? "Dark" : "Light"} />
          <div className="grid gap-2">
            <Textarea
              value={message}
              onChange={event => setMessage(event.target.value)}
              placeholder="HUNSU request"
              className={cn("min-h-20 resize-none text-[13px]", dark ? "border-white/10 bg-black/15 text-[#f4fbf7] placeholder:text-[#9eb4aa]" : "bg-white")}
              disabled={busy || draft.status === "confirmed" || draft.status === "discarded"}
            />
            <p className={cn("text-[11px] leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
              If you edited request files directly, ask the Draft agent to check them again.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={controls.onDiscard}
                disabled={busy || draft.status === "confirmed" || draft.status === "discarded"}
              >
                <X className="mr-2 size-4" />
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  const text = message.trim();
                  if (!text) return;
                  controls.onSendMessage(text);
                  setMessage("");
                }}
                disabled={busy || !message.trim() || draft.status === "confirmed" || draft.status === "discarded"}
              >
                <Send className="mr-2 size-4" />
                Send
              </Button>
            </div>
          </div>

          {controls.error || draft.error ? (
            <p className="break-words text-[12px] leading-5 text-[#e11d48]">{controls.error ?? draft.error}</p>
          ) : null}
        </div>
      )}
    </InspectorSection>
  );
}

function HunsuDraftChangePanel({ dark, controls, draftSession }: { dark: boolean; controls: HunsuDraftPanelControls; draftSession?: AgentSessionView }) {
  const draft = controls.draft;
  const busy = controls.busy === true;
  const diffMarkers = useMemo(() => draft ? hunsuDraftDiffMarkers(draft, draftSession) : [], [draft, draftSession]);
  const reviewRef = useMemo(() => draft ? hunsuDraftCurrentReviewArtifactRef(draft, diffMarkers) : undefined, [draft, diffMarkers]);
  const artifact = draft && reviewRef ? hunsuDraftDiffArtifactForRef(draft, controls, reviewRef) : undefined;

  useEffect(() => {
    if (!draft || !reviewRef || artifact) return;
    void controls.onLoadDiffArtifact(reviewRef.draftSessionId, reviewRef.diffArtifactId).catch(() => undefined);
  }, [artifact, controls, draft, reviewRef]);

  if (!draft) {
    return (
      <InspectorSection>
        <div className="flex items-center gap-2">
          <Settings2 className="size-4 shrink-0 text-[color:var(--studio-galio)]" />
          <h3 className="truncate text-[12px] font-semibold">HUNSU Change</h3>
        </div>
        <p className={cn("mt-2 text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>Start a HUNSU Draft before reviewing runtime changes.</p>
      </InspectorSection>
    );
  }

  return (
    <div className="grid gap-5">
      <InspectorSection>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Settings2 className="size-4 shrink-0 text-[color:var(--studio-galio)]" />
            <h3 className="truncate text-[12px] font-semibold">HUNSU Change</h3>
          </div>
          <Badge variant={draft.status === "failed" ? "destructive" : draft.status === "ready" || draft.status === "confirmed" ? "success" : "secondary"} className="shrink-0">
            {draft.status}
          </Badge>
        </div>
        <div className={cn("mt-3 border-l pl-3 text-[12px] leading-5", dark ? "border-white/15 text-[#aabbb3]" : "border-[#d9dfda] text-[#626b66]")}>
          <p>Review the decoded runtime diff before approval.</p>
          <p className="mt-1 font-mono text-[11px]">.hunsu-prev/ -&gt; .hunsu-request/</p>
        </div>
      </InspectorSection>

      {reviewRef ? (
        <HunsuDraftDiffArtifactCard
          artifact={artifact}
          marker={reviewRef}
          dark={dark}
          busy={busy}
          draftStatus={draft.status}
          latestDiffArtifactId={draft.latestDiffArtifactId}
          onApprove={controls.onApprove}
        />
      ) : (
        <InspectorSection className={cn("border-l pl-3", dark ? "border-white/15" : "border-[#d9dfda]")}>
          <h4 className="text-[12px] font-semibold">No DiffArtifact yet</h4>
          <p className={cn("mt-2 text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
            Ask the Draft agent to check the request files after editing .hunsu-request/.
          </p>
        </InspectorSection>
      )}

      {controls.error || draft.error ? (
        <p className="break-words text-[12px] leading-5 text-[#e11d48]">{controls.error ?? draft.error}</p>
      ) : null}
    </div>
  );
}

function HunsuDraftDiffArtifactCard({ artifact, marker, dark, busy, draftStatus, latestDiffArtifactId, onApprove }: {
  artifact?: StudioHunsuDraftDiffArtifact;
  marker: HunsuDraftDiffMarker;
  dark: boolean;
  busy: boolean;
  draftStatus: StudioHunsuDraftSession["status"];
  latestDiffArtifactId?: string;
  onApprove: (diffArtifactId: string, teamName: string) => void;
}) {
  const status = artifact?.status ?? marker.status;
  const canConfirm = canConfirmHunsuDiffArtifact(artifact, draftStatus, latestDiffArtifactId);
  const staleArtifact = artifact?.status === "pass" && artifact.diffArtifactId !== latestDiffArtifactId;
  const [teamName, setTeamName] = useState(artifact?.newTeamName ?? "");
  useEffect(() => {
    setTeamName(artifact?.newTeamName ?? "");
  }, [artifact?.diffArtifactId, artifact?.newTeamName]);
  const approvedTeamName = teamName.trim();
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden border-l pl-3", dark ? "border-white/15" : "border-[#d9dfda]")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Settings2 className="size-4 shrink-0 text-[color:var(--studio-galio)]" />
            <h4 className="truncate text-[12px] font-semibold">HUNSU DiffArtifact</h4>
          </div>
          <p className={cn("mt-1 truncate font-mono text-[10px] leading-3", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
            {artifact?.diffArtifactId ?? marker.diffArtifactId}{artifact?.checkedAt ? ` · ${artifact.checkedAt}` : ""}
          </p>
        </div>
        <Badge variant={status === "pass" ? "success" : status === "failed" ? "destructive" : "secondary"} className="shrink-0">
          {status}
        </Badge>
      </div>

      {artifact?.files.length ? (
        <div className="mt-3 grid gap-2">
          {artifact.files.map((change, index) => (
            <RuntimeFileChangeRow key={`${change.kind}-${change.path}-${index}`} change={change} dark={dark} />
          ))}
        </div>
      ) : (
        <p className={cn("mt-3 text-[12px] leading-5", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>No runtime file diff loaded yet.</p>
      )}

      {artifact?.errors.length ? (
        <div className="mt-3 grid gap-1">
          {artifact.errors.map((error, index) => (
            <p key={`${error}-${index}`} className="break-words text-[11px] leading-4 text-[#e11d48]">{error}</p>
          ))}
        </div>
      ) : null}
      {staleArtifact ? (
        <p className={cn("mt-3 text-[11px] leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
          A newer DiffArtifact exists. Confirm the latest card.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Input
          aria-label="Team name"
          value={teamName}
          onChange={event => setTeamName(event.target.value)}
          disabled={busy || !artifact || !canConfirm}
          className="h-8 w-[168px] font-mono text-[12px]"
        />
        <Button type="button" size="sm" onClick={() => artifact && onApprove(artifact.diffArtifactId, approvedTeamName)} disabled={busy || !artifact || !canConfirm || !approvedTeamName}>
          <Check className="mr-2 size-4" />
          Confirm Hunsu
        </Button>
      </div>
    </div>
  );
}

export function canConfirmHunsuDiffArtifact(
  artifact: StudioHunsuDraftDiffArtifact | undefined,
  draftStatus: StudioHunsuDraftSession["status"],
  latestDiffArtifactId: string | undefined
): boolean {
  return artifact?.status === "pass"
    && artifact.diffArtifactId === latestDiffArtifactId
    && draftStatus !== "confirmed"
    && draftStatus !== "discarded";
}

function RuntimeFileChangeRow({ change, dark }: { change: StudioHunsuDraftRuntimeFileDiff; dark: boolean }) {
  const diff = change.diff || "Diff content is not available for this artifact.";
  return (
    <div className={cn("min-w-0 max-w-full overflow-hidden border-t py-3 text-[11px]", dark ? "border-white/10" : "border-[#d9dfda]")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold">{change.path}</span>
        <Badge variant="outline" className="shrink-0">{change.kind}</Badge>
      </div>
      <WrappedDiffPanel ariaLabel={`Diff for ${change.path}`} dark={dark} diff={diff} />
    </div>
  );
}

function WrappedDiffPanel({ ariaLabel, dark, diff }: { ariaLabel: string; dark: boolean; diff: string }) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "mt-2 max-h-[520px] w-full max-w-full overflow-x-hidden overflow-y-auto rounded border p-2 font-mono text-[11px] leading-[16px]",
        dark ? "border-white/10 bg-[#050807] text-[#dce7e1]" : "border-[#d9dfda] bg-[#fbfdfb] text-[#1e2722]"
      )}
      role="region"
    >
      {diff.split("\n").map((line, index) => {
        const segment = splitRuntimeDiffLine(line);
        return (
          <div key={`${index}:${line}`} className={cn("grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] rounded-sm", runtimeDiffLineClass(line, dark))}>
            <span className={cn("select-none pr-2 text-right", dark ? "text-[#93a39a]" : "text-[#647067]")}>{segment.gutter}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]">{segment.content || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

export function splitRuntimeDiffLine(line: string): { gutter: string; content: string } {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("\\")) {
    return { gutter: "", content: line };
  }
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return { gutter: line[0], content: line.slice(1) };
  }
  return { gutter: "", content: line };
}

function runtimeDiffLineClass(line: string, dark: boolean): string {
  if (line.startsWith("@@")) {
    return dark ? "text-[#93c5fd]" : "text-[#2563eb]";
  }
  if (line.startsWith("diff --git") || line.startsWith("+++") || line.startsWith("---")) {
    return dark ? "text-[#93a39a]" : "text-[#647067]";
  }
  if (line.startsWith("+")) {
    return dark ? "bg-[#052e1b] text-[#bbf7d0]" : "bg-[#dcfce7] text-[#166534]";
  }
  if (line.startsWith("-")) {
    return dark ? "bg-[#3f121b] text-[#fecdd3]" : "bg-[#ffe4e6] text-[#be123c]";
  }
  return "";
}

export type HunsuDraftDiffMarker = {
  draftSessionId: string;
  diffArtifactId: string;
  status: "pass" | "failed";
};

export type HunsuDraftDiffReviewRef = HunsuDraftDiffMarker & {
  source: "latest" | "marker";
};

function hunsuDraftMessages(draft: StudioHunsuDraftSession, draftSession: AgentSessionView | undefined): AgentChatMessage[] {
  const sessionMessages = messagesForAgentSession(draftSession, "Draft Agent", "Draft agent has not emitted chat yet.").map(message => ({
    ...message,
    text: stripHunsuDiffMarkers(message.text),
    detail: undefined
  }));
  if (sessionMessages.length > 0) {
    return sessionMessages;
  }
  return draft.messages.map(message => ({
    id: message.messageId,
    speaker: message.role === "user" ? "Director" : message.role === "draft-agent" ? "Draft Agent" : "System",
    title: message.role === "user" ? "Prompt" : "Reply",
    text: stripHunsuDiffMarkers(message.text),
    status: isOptimisticReplyMessage(message.messageId) ? "Running" : draft.status === "failed" ? "Failed" : "Done",
    meta: message.role,
    role: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
    startedAt: message.createdAt,
    updatedAt: message.createdAt,
    completedAt: message.createdAt,
    detail: undefined
  }));
}

function hunsuDraftDiffMarkers(draft: StudioHunsuDraftSession, draftSession: AgentSessionView | undefined): HunsuDraftDiffMarker[] {
  return uniqueHunsuDraftDiffMarkers([
    ...draft.messages
      .filter(message => message.role === "draft-agent")
      .flatMap(message => parseHunsuDiffMarkers(message.text)),
    ...(draftSession?.session.messages ?? [])
      .filter(message => message.role === "assistant" || message.type === "hunsuDraft.draft-agent")
      .flatMap(message => parseHunsuDiffMarkers(agentMessageMarkerSourceText(message)))
  ]);
}

function uniqueHunsuDraftDiffMarkers(markers: HunsuDraftDiffMarker[]): HunsuDraftDiffMarker[] {
  const seen = new Set<string>();
  return markers.filter(marker => {
    const key = `${marker.draftSessionId}:${marker.diffArtifactId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function agentMessageMarkerSourceText(message: AgentSessionView["session"]["messages"][number]): string {
  return [
    message.text,
    message.output,
    message.summary?.join("\n"),
    message.content?.join("\n")
  ].filter((value): value is string => Boolean(value)).join("\n");
}

export function hunsuDraftCurrentReviewArtifactRef(
  draft: StudioHunsuDraftSession,
  markers: readonly HunsuDraftDiffMarker[]
): HunsuDraftDiffReviewRef | undefined {
  if (draft.latestDiffArtifactId) {
    const marker = markers.find(candidate => candidate.draftSessionId === draft.draftSessionId && candidate.diffArtifactId === draft.latestDiffArtifactId);
    const record = draft.diffArtifacts?.[draft.latestDiffArtifactId];
    return {
      draftSessionId: draft.draftSessionId,
      diffArtifactId: draft.latestDiffArtifactId,
      status: record?.status ?? marker?.status ?? "pass",
      source: "latest"
    };
  }
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (marker.draftSessionId === draft.draftSessionId) {
      return { ...marker, source: "marker" };
    }
  }
  return undefined;
}

function hunsuDraftDiffArtifactForRef(
  draft: StudioHunsuDraftSession,
  controls: HunsuDraftPanelControls,
  ref: HunsuDraftDiffReviewRef
): StudioHunsuDraftDiffArtifact | undefined {
  return controls.diffArtifacts?.[hunsuDraftDiffArtifactKey(ref.draftSessionId, ref.diffArtifactId)]
    ?? draft.diffArtifacts?.[ref.diffArtifactId];
}

export function parseHunsuDiffMarkers(text: string): HunsuDraftDiffMarker[] {
  const markers: HunsuDraftDiffMarker[] = [];
  const pattern = /::hunsu-diff\{([^}]*)\}/g;
  for (const match of text.matchAll(pattern)) {
    const attributes = parseMarkerAttributes(match[1] ?? "");
    const status = attributes.status === "failed" ? "failed" : attributes.status === "pass" ? "pass" : undefined;
    if (isConcreteHunsuDiffMarkerAttribute(attributes.draftSessionId)
      && isConcreteHunsuDiffMarkerAttribute(attributes.diffArtifactId)
      && attributes.diffArtifactId.startsWith("hdd_")
      && status) {
      markers.push({
        draftSessionId: attributes.draftSessionId,
        diffArtifactId: attributes.diffArtifactId,
        status
      });
    }
  }
  return markers;
}

function isConcreteHunsuDiffMarkerAttribute(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !/[<>]/.test(value));
}

function stripHunsuDiffMarkers(text: string): string {
  return text.replace(/\n?::hunsu-diff\{[^}]*\}/g, "").trim();
}

function parseMarkerAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function hunsuDraftDiffArtifactKey(draftSessionId: string, diffArtifactId: string): string {
  return `${draftSessionId}:${diffArtifactId}`;
}

function isOptimisticReplyMessage(messageId: string): boolean {
  return messageId.includes(":optimistic:reply:");
}

function formatUnknown(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Unset";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(item => `- ${formatUnknown(item)}`).join("\n") : "[]";
  }
  if (isRecord(value)) {
    return formatUnknownRecord(value);
  }
  return String(value);
}

function formatUnknownRecord(value: unknown): string {
  if (!isRecord(value)) return formatUnknown(value);
  const entries = Object.entries(value).filter(([, child]) => child !== undefined && child !== null && child !== "");
  if (entries.length === 0) return "{}";
  return entries.map(([key, child]) => `${humanizeField(key)}: ${formatUnknown(child)}`).join("\n");
}

function formatMemberSkillMetadata(value: unknown): string {
  if (!isRecord(value)) {
    return formatUnknownRecord(value);
  }
  if (value.kind === "registry-package") {
    return [
      `APM package: ${formatUnknown(value.package)}@${formatUnknown(value.version)}`,
      `Name: ${formatUnknown(value.name)}`,
      `Registry: ${formatUnknown(value.registry)}`,
      `Integrity: ${formatUnknown(value.integrity)}`,
      `Content hash: ${formatUnknown(value.contentHash)}`
    ].join("\n");
  }
  if (value.kind === "local-snapshot") {
    return [
      `Local snapshot: ${formatUnknown(value.name)}`,
      `Source: ${formatUnknown(value.sourcePath)}`,
      `Snapshot: ${formatUnknown(value.snapshotRef)}`,
      `Content hash: ${formatUnknown(value.contentHash)}`
    ].join("\n");
  }
  if (value.kind === "skillMeta") {
    return [
      `Skills CLI: ${formatUnknown(value.name)}`,
      `Source: ${formatUnknown(value.source)}`,
      `Agent: ${formatUnknown(value.agent)}`
    ].join("\n");
  }
  return formatUnknownRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanizeField(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, letter => letter.toUpperCase());
}

function ExecuteInspector({ inspector, dark, showChat = true }: { inspector: Extract<InspectorModel, { kind: "execute" }>; dark: boolean; showChat?: boolean }) {
  const planMessages = messagesForAgentSession(inspector.planSession, "Team", "TeamPlan has not emitted chat yet.");
  const planStatus = planStatusForExecuteInspector(inspector);
  return (
    <>
      <section>
        <SectionHeader dark={dark} label="Plan Log" title={planSectionTitle(inspector.planSession, inspector.run)} badge={planStatusLabel(planStatus)} />
        <SessionHint dark={dark} session={inspector.planSession} />
        {showChat ? <div className="mt-2 grid gap-2">
          <AgentChat session={inspector.planSession?.session} messages={planMessages} theme={dark ? "Dark" : "Light"} />
        </div> : null}
      </section>
      <ExecutionTransitionPanel
        dark={dark}
        transition={inspector.planExecutionTransition}
        emptyMessage="No current execution transition is stored for this Plan commit."
      />
    </>
  );
}

function PathPointInspector({ inspector, dark, showChat = true }: { inspector: Extract<InspectorModel, { kind: "pathPoint" }>; dark: boolean; showChat?: boolean }) {
  const point = inspector.point;
  const pathStatus = agentSessionBadge(inspector.executionSession, point.cssState);
  return (
    <>
      <section>
        <SectionHeader dark={dark} label="Plan" title={point.pathId ?? point.executorId ?? "Path"} badge={pathStatus} />
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{point.goal}</p>
      </section>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Metric dark={dark} label="Commit" value={formatShortRef(point.commit ?? inspector.pathRun?.commit)} icon={<GitCommit className="size-3.5" />} />
        <Metric dark={dark} label="Depends on" value={inspector.dependencies.join(", ") || "PrevMove"} icon={<Route className="size-3.5" />} />
      </div>

      <section>
        <h3 className="text-[12px] font-semibold leading-4">Execution Log</h3>
        <SessionHint dark={dark} session={inspector.executionSession} />
        {showChat ? <div className="mt-2">
	          <AgentChat session={inspector.executionSession?.session} messages={messagesForAgentSession(inspector.executionSession, point.executorId ?? "Agent", inspector.pathRun?.goal ?? "Member Path has not emitted chat yet.")} theme={dark ? "Dark" : "Light"} />
        </div> : null}
      </section>

      {inspector.pathRun?.finalResponse ? <CompactList dark={dark} title="Final Response" items={[inspector.pathRun.finalResponse]} /> : null}
      <ExecutionTransitionPanel
        dark={dark}
        transition={inspector.pathRun?.currentExecutionTransition ?? transitionFromCurrentFile(inspector.pathRun?.currentExecutionFile)}
        emptyMessage="No current execution transition is stored for this Path commit."
      />
      {inspector.pathRun?.error ? <CompactList dark={dark} title="Error" items={[inspector.pathRun.error]} /> : null}
    </>
  );
}

function ExecutionTransitionPanel({ dark, transition, emptyMessage }: { dark: boolean; transition?: StudioExecutionTransition; emptyMessage: string }) {
  return (
    <InspectorSection>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[12px] font-semibold">Execution Transition</h3>
        {transition?.nextCommit ? <span className={cn("font-mono text-[11px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{formatShortRef(transition.nextCommit)}</span> : null}
        {transition?.nextState === "pending" ? <span className={cn("text-[11px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>pending</span> : null}
      </div>
      {transition ? (
        <div className={cn("mt-2 divide-y", dark ? "divide-white/10" : "divide-[#d9dfda]")}>
          <RuntimeFilePreview dark={dark} label="Prev" file={transition.previous} commit={transition.previousCommit} state={transition.previousState ?? (transition.previous ? "present" : "none")} />
          <RuntimeFilePreview dark={dark} label="Next" file={transition.next} commit={transition.nextCommit} state={transition.nextState ?? (transition.next ? "present" : "none")} />
        </div>
      ) : (
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
          {emptyMessage}
        </p>
      )}
    </InspectorSection>
  );
}

function RuntimeFilePreview({ dark, label, file, commit, state }: { dark: boolean; label: "Prev" | "Next"; file?: StudioEncodedRuntimeFile; commit?: string; state: "present" | "none" | "pending" }) {
  const [decoded, setDecoded] = useState<{ status: "idle" | "loading" | "ready" | "error"; text?: string; error?: string }>({ status: file ? "loading" : "idle" });

  useEffect(() => {
    if (!file) {
      setDecoded({ status: "idle" });
      return;
    }
    let active = true;
    setDecoded({ status: "loading" });
    decodeHunsuRuntimeFileText(file.text)
      .then(value => {
        if (active) {
          setDecoded({ status: "ready", text: JSON.stringify(value, null, 2) });
        }
      })
      .catch(error => {
        if (active) {
          setDecoded({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [file?.commit, file?.text]);

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold">{label}</p>
        {commit ? <span className={cn("font-mono text-[11px]", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{formatShortRef(commit)}</span> : null}
      </div>
      {file ? (
        <>
          <p className={cn("mt-1 text-[11px] leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{file.path}</p>
          <WrappedRuntimeTextPanel
            dark={dark}
            text={decoded.status === "ready" ? decoded.text ?? "" : decoded.status === "error" ? `Decode failed: ${decoded.error}` : "Decoding..."}
          />
        </>
      ) : (
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>
          {state === "pending" ? "pending" : "none"}
        </p>
      )}
    </div>
  );
}

function WrappedRuntimeTextPanel({ dark, text }: { dark: boolean; text: string }) {
  return (
    <div className={cn(
      "mt-2 max-h-56 w-full max-w-full overflow-x-hidden overflow-y-auto rounded border p-2 font-mono text-[11px] leading-4",
      dark ? "border-white/10 bg-black/15 text-[#dce9e2]" : "border-[#d9dfda] bg-[#fbfdfb] text-[#20251f]"
    )}>
      {splitWrappedTextLines(text).map(line => (
        <div key={`${line.lineNumber}:${line.text}`} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)]">
          <span className={cn("select-none pr-3 text-right", dark ? "text-[#728178]" : "text-[#8a958d]")}>{line.lineNumber}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

export function splitWrappedTextLines(text: string): Array<{ lineNumber: number; text: string }> {
  return text.split("\n").map((line, index) => ({ lineNumber: index + 1, text: line }));
}

function transitionFromCurrentFile(file: StudioEncodedRuntimeFile | undefined): StudioExecutionTransition | undefined {
  return file ? { path: file.path, previousState: "none", nextCommit: file.commit, next: file, nextState: "present" } : undefined;
}

async function decodeHunsuRuntimeFileText(text: string): Promise<unknown> {
  const normalized = text.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator === -1) {
    throw new Error("Invalid runtime envelope");
  }
  const header = normalized.slice(0, separator).split("\n");
  const payload = normalized.slice(separator + 2).trim();
  if (header[0] !== "HUNSU_RUNTIME_FILE_V1") {
    throw new Error("Invalid runtime header");
  }
  const metadata = new Map(header.slice(1).map(line => {
    const index = line.indexOf(":");
    return index === -1 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  if (metadata.get("encoding") !== "gzip+base64url") {
    throw new Error(`Unsupported runtime encoding: ${metadata.get("encoding") ?? "missing"}`);
  }
  const bytes = base64UrlToBytes(payload);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser does not support gzip runtime decoding");
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const json = await new Response(stream).text();
  return JSON.parse(json);
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function HunsuInspector({ inspector, dark, actions }: { inspector: Extract<InspectorModel, { kind: "hunsu" }>; dark: boolean; actions?: ReactNode }) {
  const fromNodeId = inspector.hunsu?.fromNodeId
    ?? (inspector.node.node.source.type === "hunsu" ? inspector.node.node.source.fromNodeId : undefined)
    ?? "unknown";

  return (
    <>
      <section>
        <SectionHeader dark={dark} label="HUNSU route change" title={inspector.title} badge="draft" />
        <p className={cn("mt-2 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{inspector.summary}</p>
      </section>

      {actions ? (
        <section className="grid gap-2">
          <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>Execute next</p>
          {actions}
        </section>
      ) : null}

      {!inspector.action.canStartExecute && inspector.action.disabledReason ? (
        <InspectorSection>
          <p className="text-[12px] font-semibold">Execute unavailable</p>
          <p className={cn("mt-1 text-[12px] leading-[18px]", dark ? "text-[#aabbb3]" : "text-[#626b66]")}>{inspector.action.disabledReason}</p>
        </InspectorSection>
      ) : null}

      <InspectorSection>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-[color:var(--studio-galio)]" />
          <h3 className="text-[12px] font-semibold">Runtime Changes</h3>
        </div>
        <dl className="mt-3 grid gap-2 text-[12px]">
          <Row dark={dark} label="From" value={String(fromNodeId)} />
          <Row dark={dark} label="To" value={String(inspector.hunsu?.toNodeId ?? inspector.node.id)} />
          <Row dark={dark} label="Target" value={inspector.hunsu?.target ? `${inspector.hunsu.target.type}:${String(inspector.hunsu.target.id)}` : "pending"} />
        </dl>
      </InspectorSection>

      {inspector.hunsu?.changedFiles?.length ? (
        <CompactList dark={dark} title="Changed Files" items={inspector.hunsu.changedFiles.map(file => `${file.path} (${file.kind})`)} />
      ) : null}
    </>
  );
}

function SectionHeader({ dark, label, title, badge }: { dark: boolean; label: string; title: string; badge: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className={cn("text-[11px] font-semibold leading-4", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>{label}</p>
        <h3 className="mt-1 truncate text-[15px] font-semibold leading-5">{title}</h3>
      </div>
      <Badge variant={badge.toLowerCase().includes("accident") || badge === "failed" ? "destructive" : badge.toLowerCase().includes("arrived") || badge === "done" ? "success" : "secondary"} className="shrink-0">
        {badge}
      </Badge>
    </div>
  );
}

function InspectorSection({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("min-w-0", className)}>{children}</section>;
}

function Metric({ dark, label, value, icon }: { dark: boolean; label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={cn("flex items-center gap-1.5", dark ? "text-[#9eb4aa]" : "text-[#626b66]")}>
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 truncate font-medium">{value}</p>
    </div>
  );
}

function Row({ dark, label, value }: { dark: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={dark ? "text-[#9eb4aa]" : "text-[#626b66]"}>{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  );
}

function CompactList({ dark, title, items }: { dark: boolean; title: string; items: string[] }) {
  return (
    <InspectorSection>
      <h3 className="text-[12px] font-semibold">{title}</h3>
      <ul className="mt-2 grid gap-1.5 text-[12px]">
        {items.map((item, index) => <li key={`${title}-${index}`} className="break-words">{item}</li>)}
      </ul>
    </InspectorSection>
  );
}

function planSectionTitle(session: AgentSessionView | undefined, run: Extract<InspectorModel, { kind: "execute" }>["run"]): string {
  if ((run.executionPlanPlan?.length ?? 0) > 0 || (run.memberPathRuns?.length ?? 0) > 0) return "Team Plan";
  if (session?.status === "done") return "Team Plan";
  if (session?.status === "failed") return "Plan Failed";
  if (session?.status === "running") return "Planning";
  if (session?.status === "waiting") return "Waiting";
  return run.liveStatus?.headline ?? "Team Plan";
}

function agentSessionBadge(session: AgentSessionView | undefined, fallback: string): string {
  if (!session) return fallback;
  if (session.status === "done") return "done";
  if (session.status === "failed") return "failed";
  if (session.status === "running") return "running";
  return "waiting";
}

function inspectorShouldStickToBottom(inspector: InspectorModel): boolean {
  if (inspector.kind === "hunsuDraftRoute") {
    return inspector.draftSession?.status === "running";
  }
  if (inspector.kind === "execute") {
    const planStatus = planStatusForExecuteInspector(inspector);
    return planStatus === "running" || planStatus === "waiting";
  }
  if (inspector.kind === "pathPoint") {
    return inspector.point.cssState === "running"
      || inspector.pathRun?.status === "starting"
      || inspector.pathRun?.status === "executing"
      || inspector.executionSession?.status === "running"
      || inspector.executionSession?.status === "waiting";
  }
  return false;
}

function inspectorScrollKey(inspector: InspectorModel): string {
  if (inspector.kind === "execute") {
    return `execute:${inspector.run.executeId}:${inspector.planSession?.sessionId ?? "none"}`;
  }
  if (inspector.kind === "pathPoint") {
    return `path:${inspector.run.executeId}:${inspector.point.pathId ?? inspector.point.id}:${inspector.executionSession?.sessionId ?? "none"}`;
  }
  if (inspector.kind === "hunsuDraftRoute") {
    return `hunsu-draft:${inspector.draft.draftSessionId}:${inspector.draftSession?.sessionId ?? "none"}`;
  }
  if (inspector.kind === "move") {
    return `move:${inspector.node.id}`;
  }
  return `hunsu:${inspector.node.id}`;
}

function inspectorContentKey(inspector: InspectorModel): string {
  if (inspector.kind === "execute") {
    return [
      inspector.run.executeId,
      inspector.planExecutionTransition?.previousCommit,
      inspector.planExecutionTransition?.previous?.text.length ?? 0,
      inspector.planExecutionTransition?.nextCommit,
      inspector.planExecutionTransition?.next?.text.length ?? 0,
      sessionContentKey(inspector.planSession)
    ].join("|");
  }
  if (inspector.kind === "pathPoint") {
    return [
      inspector.point.cssState,
      inspector.pathRun?.status,
      inspector.pathRun?.finalResponse,
      inspector.pathRun?.error,
      inspector.pathRun?.currentExecutionTransition?.previousCommit,
      inspector.pathRun?.currentExecutionTransition?.previous?.text.length ?? 0,
      inspector.pathRun?.currentExecutionTransition?.nextCommit,
      inspector.pathRun?.currentExecutionTransition?.next?.text.length ?? 0,
      inspector.pathRun?.currentExecutionFile?.commit,
      inspector.pathRun?.currentExecutionFile?.text.length ?? 0,
      sessionContentKey(inspector.executionSession)
    ].join("|");
  }
  if (inspector.kind === "hunsuDraftRoute") {
    return [
      inspector.draft.draftSessionId,
      inspector.draft.status,
      inspector.draft.messages.length,
      inspector.draft.messages.at(-1)?.messageId,
      inspector.draft.updatedAt,
      sessionContentKey(inspector.draftSession)
    ].join("|");
  }
  if (inspector.kind === "move") {
    return `${inspector.node.id}:${inspector.node.card.statusLabel}:${inspector.reachedDestinations.length}:${inspector.remainingDestinations.length}`;
  }
  return `${inspector.node.id}:${inspector.summary}`;
}

function inspectorTabResetKey(inspector: InspectorModel): string {
  if (inspector.kind === "execute") return `execute:${inspector.run.executeId}`;
  if (inspector.kind === "pathPoint") return `path:${inspector.point.pathId ?? inspector.point.id}`;
  if (inspector.kind === "hunsuDraftRoute") return `hunsuDraft:${inspector.draft.draftSessionId}`;
  if (inspector.kind === "move") return `move:${inspector.node.id}`;
  return `hunsu:${inspector.node.id}`;
}

function sessionContentKey(session: AgentSessionView | undefined): string {
  if (!session) return "none";
  const messages = session.session.messages;
  const last = messages.at(-1);
  return [
    session.sessionId,
    session.status,
    session.session.revision,
    messages.length,
    last?.messageId,
    last?.revision,
    last?.status,
    last?.text?.length ?? 0,
    last?.output?.length ?? 0,
    last?.summary?.join("").length ?? 0,
    last?.content?.join("").length ?? 0
  ].join(":");
}

function SessionHint({ dark, session }: { dark: boolean; session?: AgentSessionView }) {
  if (!session?.providerTurnId && !session?.providerThreadId) {
    return (
      <p className={cn("mt-1 text-[11px] leading-4", dark ? "text-[#9eb4aa]" : "text-[color:var(--apple-faint)]")}>
        Waiting for execution session.
      </p>
    );
  }
  return (
    <p className={cn("mt-1 truncate text-[11px] leading-4", dark ? "text-[#9eb4aa]" : "text-[color:var(--apple-faint)]")}>
      session {shortSessionId(session.providerTurnId ?? session.providerThreadId)}
    </p>
  );
}

function inspectorEyebrow(inspector: InspectorModel): string {
  if (inspector.kind === "execute") return `PLAN · ${inspector.sourceNode.card.teamName}`;
  if (inspector.kind === "pathPoint") return `PATH · ${inspector.sourceNode.card.teamName}`;
  if (inspector.kind === "hunsuDraftRoute") return `HUNSU DRAFT · ${inspector.sourceNode.card.teamName}`;
  if (inspector.kind === "hunsu") return `HUNSU · ${inspector.node.card.teamName}`;
  return `MOVE · ${inspector.node.card.teamName} M${String(inspector.node.card.ordinal).padStart(4, "0")}`;
}

function inspectorUsesDarkTheme(inspector: InspectorModel): boolean {
  if (inspector.kind === "move") return true;
  if (inspector.kind === "hunsuDraftRoute") return false;
  if (inspector.kind === "execute") return planStatusForExecuteInspector(inspector) === "done";
  if (inspector.kind === "pathPoint") return inspector.point.cssState === "done";
  return false;
}

function inspectorHeading(inspector: InspectorModel): string {
  if (inspector.kind === "execute") return `${inspector.sourceNode.card.title} Plan`;
  if (inspector.kind === "pathPoint") return inspector.point.executorId ?? inspector.point.pathId ?? "Path point";
  if (inspector.kind === "hunsuDraftRoute") return inspector.route.label;
  if (inspector.kind === "hunsu") return inspector.title;
  return inspector.title;
}

function inspectorStatus(inspector: InspectorModel): string {
  if (inspector.kind === "execute") return planStatusLabel(planStatusForExecuteInspector(inspector));
  if (inspector.kind === "pathPoint") return inspector.point.cssState;
  if (inspector.kind === "hunsuDraftRoute") return inspector.draft.status;
  if (inspector.kind === "hunsu") return "HUNSU";
  return inspector.node.card.statusLabel;
}

function inspectorSummary(inspector: InspectorModel): string {
  if (inspector.kind === "execute") return planInspectorSummary(planStatusForExecuteInspector(inspector));
  if (inspector.kind === "pathPoint") return `${inspector.point.progress} path from Execute ${inspector.run.executeId}.`;
  if (inspector.kind === "hunsuDraftRoute") {
    return inspector.draft.latestDiffArtifactId ? "DiffArtifact ready for review." : "Interactive route-change draft.";
  }
  if (inspector.kind === "hunsu") return inspector.summary;
  return inspector.subtitle;
}

function inspectorDetailLine(inspector: InspectorModel): string | undefined {
  if (inspector.kind === "execute") return undefined;
  if (inspector.kind === "pathPoint") return inspector.point.goal;
  if (inspector.kind === "hunsuDraftRoute") return `Source ${inspector.sourceNode.card.teamName} M${String(inspector.sourceNode.card.ordinal).padStart(4, "0")}`;
  if (inspector.kind === "hunsu") return inspector.summary;
  return inspector.summary;
}

function planStatusForExecuteInspector(inspector: Extract<InspectorModel, { kind: "execute" }>): AgentSessionView["status"] {
  if ((inspector.run.executionPlanPlan?.length ?? 0) > 0 || (inspector.run.memberPathRuns?.length ?? 0) > 0) return "done";
  if (inspector.planSession?.status) return inspector.planSession.status;
  if (inspector.run.status === "failed" || inspector.run.status === "accident") return "failed";
  if (inspector.run.status === "running" || inspector.run.status === "paused") return "running";
  return "waiting";
}

function planStatusLabel(status: AgentSessionView["status"]): string {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "waiting";
}

function planInspectorSummary(status: AgentSessionView["status"]): string {
  if (status === "done") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Planning";
  return "Waiting";
}

function messagesForAgentSession(session: AgentSessionView | undefined, speaker: string, emptyBodyText: string): AgentChatMessage[] {
  const sourceMessages = session?.session.messages ?? [];
  const messages = sourceMessages
    .filter(message => isVisibleAgentMessage(message, sourceMessages))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((message): AgentChatMessage => ({
      id: message.messageId,
      speaker: message.role === "user" ? "User" : message.role === "tool" ? "Tool" : speaker,
      title: message.title,
      text: formatAgentMessageBodyForDisplay(message, emptyBodyText),
      status: message.status === "completed" ? "Done" : message.status === "streaming" ? "Running" : "Waiting",
      meta: [message.type, shortSessionId(session?.providerTurnId)].filter(Boolean).join(" / "),
      role: message.role,
      startedAt: message.createdAt,
      updatedAt: message.updatedAt,
      completedAt: message.completedAt,
      durationMs: message.durationMs
    }));
  if (messages.length > 0) {
    return messages;
  }
  if (!session) {
    return [];
  }
  if (session.status === "running" || session.status === "waiting") {
    return [startingAgentSessionMessage(session, speaker)];
  }
  if (!session.session.finalResponse && !session.session.error) {
    return [];
  }
  return [{
    id: `${session.sessionId}-placeholder`,
    speaker,
    title: session.status === "done" ? "Complete" : session.status === "failed" ? "Failed" : "Running",
    text: session.session.finalResponse ?? session.session.error ?? emptyBodyText,
    status: session.status === "done" ? "Done" : session.status === "failed" ? "Failed" : "Running",
    meta: shortSessionId(session.providerTurnId)
  }];
}

function startingAgentSessionMessage(session: AgentSessionView, speaker: string): AgentChatMessage {
  const running = session.status === "running";
  return {
    id: `${session.sessionId}-starting`,
    speaker,
    title: running ? "Starting" : "Waiting",
    text: running ? "Starting agent turn." : "Waiting for the next agent turn.",
    status: running ? "Running" : "Waiting",
    meta: shortSessionId(session.providerTurnId),
    startedAt: session.session.createdAt,
    updatedAt: session.session.updatedAt
  };
}

export function isVisibleAgentMessage(message: AgentSessionView["session"]["messages"][number], allMessages: AgentSessionView["session"]["messages"]): boolean {
  if (message.type === "userMessage" && (allMessages.some(candidate => candidate.type === "hunsuDraft.user") || isInternalHunsuDraftPromptMessage(message))) {
    return false;
  }
  if (message.type === "hunsuDraft.draft-agent" && allMessages.some(candidate => candidate.role === "assistant" && candidate.type !== "hunsuDraft.draft-agent")) {
    return false;
  }
  if (message.role === "reasoning") {
    return true;
  }
  return hasAgentMessageBody(message);
}

function isInternalHunsuDraftPromptMessage(message: AgentSessionView["session"]["messages"][number]): boolean {
  if (message.type !== "userMessage") {
    return false;
  }
  const text = agentMessageMarkerSourceText(message);
  return text.includes("<draft_check_command>")
    || text.includes("::hunsu-diff{draftSessionId=\"<draftSessionId>\"");
}

function hasAgentMessageBody(message: AgentSessionView["session"]["messages"][number]): boolean {
  return Boolean(
    message.text
    || message.output
    || message.summary?.length
    || message.content?.length
    || message.command
    || message.commandActions?.length
    || message.changes
  );
}

export function formatAgentMessageBodyForDisplay(message: AgentSessionView["session"]["messages"][number], emptyBodyText: string): string {
  const parts = uniqueAgentMessageParts([
    message.text,
    message.output,
    message.summary?.join("\n"),
    message.content?.join("\n"),
    message.command ? `$ ${message.command}` : undefined,
    message.commandActions?.length ? formatAgentMessageJson(message.commandActions) : undefined,
    message.changes ? formatAgentMessageJson(message.changes) : undefined
  ]);
  if (message.role === "reasoning" && parts.length === 0) {
    return message.status === "completed" ? "Reasoning completed." : "Reasoning...";
  }
  return parts.join("\n\n") || emptyBodyText;
}

function uniqueAgentMessageParts(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const uniqueParts: string[] = [];
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const key = normalizeAgentMessagePart(part);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueParts.push(part);
  }
  return uniqueParts;
}

function normalizeAgentMessagePart(part: string): string {
  return part.replace(/\s+/g, " ").trim();
}

function formatAgentMessageJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortSessionId(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}
