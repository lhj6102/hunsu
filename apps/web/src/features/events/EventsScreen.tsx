import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { ArrowRight, Bot, CheckCircle2, ChevronRight, GitCommit, ListFilter, Loader2, Network, Play, Search, X } from "lucide-react";
import { projectEventPath, projectEventsPath, projectNodePath, pushAppPath } from "@/app/routes";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/shared/api/client";
import { pollingQueryOptions } from "@/shared/api/polling";
import { fetchEvent, fetchEvents, type EventQuery } from "@/shared/api/projectApi";
import { DOMAIN_EVENT_TYPES, type DomainEventListItem, type DomainEventType, type EventReference, type EventsResponse } from "@/shared/api/types";
import { formatTimestamp, repositoryLabel, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { PageError, PageLoading, PageRefreshWarning } from "@/shared/ui/page-state";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { useMediaQuery } from "@/shared/useMediaQuery";

const EMPTY_FILTERS: EventQuery = {
  cursor: null,
  type: null,
  nodeSha: null,
  actor: null,
  from: null,
  to: null,
  search: null
};

export function EventsScreen({ projectId, selectedEventId }: { projectId: string; selectedEventId: string | null }) {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const inspectorFocusReturnRef = useRef<HTMLElement | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["projects", projectId, "events", "v2", filters],
    queryFn: ({ pageParam, signal }) => fetchEvents(projectId, { ...filters, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
    ...pollingQueryOptions<InfiniteData<EventsResponse>>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => {
        const latest = data.pages[0]?.events[0];
        return latest !== undefined && isProgressEvent(latest.type);
      }
    })
  });
  const events = useMemo(() => uniqueEvents(query.data?.pages.flatMap(page => page.events) ?? []), [query.data?.pages]);
  const first = query.data?.pages[0];

  if (query.isLoading) return <PageLoading label="Replaying Events…" />;
  if (!first) return <PageError message={apiErrorMessage(query.error, "Events are unavailable.")} onRetry={() => void query.refetch()} />;
  const stateHeadsAgree = query.data?.pages.every(page => page.stateHeadSha === first.stateHeadSha) ?? true;

  function applyFilters(event: React.FormEvent) {
    event.preventDefault();
    setFilters({ ...draft, cursor: null });
  }

  function clearFilters() {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  }

  function openEvent(eventId: string) {
    const activeElement = document.activeElement;
    inspectorFocusReturnRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    pushAppPath(projectEventPath(projectId, eventId));
  }

  function closeEvent() {
    const focusReturn = inspectorFocusReturnRef.current;
    inspectorFocusReturnRef.current = null;
    pushAppPath(projectEventsPath(projectId));
    window.requestAnimationFrame(() => focusReturn?.focus());
  }

  return (
    <main className="apple-page relative h-[calc(100vh-3.5rem)] min-h-[560px] overflow-hidden lg:h-screen" aria-label={`${first.project.title} Events`}>
      <header className="flex min-h-[72px] flex-wrap items-center gap-3 border-b bg-white/84 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[15px]">
            <span className="truncate font-semibold">{first.project.title}</span>
            <span className="text-muted-foreground">/</span>
            <span className="shrink-0 text-muted-foreground">Events</span>
          </div>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{repositoryLabel(first.project.repository.owner, first.project.repository.name)} · append-only domain history</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="size-2 rounded-full bg-[color:var(--apple-green)]" />
          State {shortSha(first.stateHeadSha)}
        </div>
      </header>

      <div className="grid h-[calc(100%-72px)] grid-rows-[auto_minmax(0,1fr)]">
        <form className="border-b bg-white/58 px-4 py-3 sm:px-6" onSubmit={applyFilters}>
          <div className="flex flex-wrap items-end gap-2">
            <FilterField label="Search" className="min-w-[180px] flex-1">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input className="event-filter-input pl-9" value={draft.search ?? ""} onChange={event => setDraft(current => ({ ...current, search: nullable(event.target.value) }))} placeholder="Event summary or ID" />
              </div>
            </FilterField>
            <FilterField label="Type" className="w-[180px]">
              <select className="event-filter-input" value={draft.type ?? ""} onChange={event => setDraft(current => ({ ...current, type: nullable(event.target.value) }))}>
                <option value="">All event types</option>
                {DOMAIN_EVENT_TYPES.map(type => <option key={type} value={type}>{eventLabel(type)}</option>)}
              </select>
            </FilterField>
            <FilterField label="Node SHA" className="w-[150px]">
              <input className="event-filter-input font-mono" value={draft.nodeSha ?? ""} onChange={event => setDraft(current => ({ ...current, nodeSha: nullable(event.target.value) }))} placeholder="full SHA" />
            </FilterField>
            <FilterField label="Actor" className="w-[140px]">
              <input className="event-filter-input" value={draft.actor ?? ""} onChange={event => setDraft(current => ({ ...current, actor: nullable(event.target.value) }))} placeholder="Actor ID" />
            </FilterField>
            <details className="group relative">
              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] border bg-white/72 px-3 text-[11px] font-medium"><ListFilter className="size-3.5" />Date range</summary>
              <div className="absolute right-0 top-11 z-20 grid w-[280px] gap-3 rounded-[14px] border bg-white p-4 shadow-lg">
                <FilterField label="From"><input type="date" className="event-filter-input" value={draft.from ?? ""} onChange={event => setDraft(current => ({ ...current, from: nullable(event.target.value) }))} /></FilterField>
                <FilterField label="To"><input type="date" className="event-filter-input" value={draft.to ?? ""} onChange={event => setDraft(current => ({ ...current, to: nullable(event.target.value) }))} /></FilterField>
              </div>
            </details>
            <Button type="submit" size="sm">Apply</Button>
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
          </div>
        </form>

        <div className="relative min-h-0 overflow-hidden">
          {!stateHeadsAgree ? (
            <div role="alert" className="absolute left-4 right-4 top-4 z-20 rounded-[14px] border border-red-200 bg-red-50/96 px-4 py-3 text-[11px] text-red-950 sm:left-6 sm:right-6">
              Event pages were reconstructed from different state heads. Reload before using this audit view.
            </div>
          ) : null}
          {query.isError ? (
            <div className="absolute left-4 right-4 top-0 z-20 sm:left-6 sm:right-6">
              <PageRefreshWarning message={apiErrorMessage(query.error, "Events could not be refreshed.")} retrying={query.isFetching} onRetry={() => void query.refetch()} />
            </div>
          ) : null}
          <ScrollArea className="h-full">
            <div className={cn("mx-auto w-full max-w-4xl px-4 py-6 sm:px-8", selectedEventId && "md:mr-[410px]")}>
              {events.length > 0 ? (
                <ol className="relative ml-4 border-l" aria-label="Append-only Hunsu Events">
                  {events.map(event => <EventRow key={event.id} event={event} selected={event.id === selectedEventId} onSelect={() => openEvent(event.id)} />)}
                </ol>
              ) : (
                <div className="rounded-[18px] border border-dashed bg-white/54 px-6 py-12 text-center">
                  <p className="text-sm font-semibold">No Events match these filters.</p>
                  <p className="mt-2 text-xs text-muted-foreground">Events are immutable and cannot be edited or removed from this view.</p>
                </div>
              )}
              {query.hasNextPage ? (
                <div className="mt-6 flex justify-center">
                  <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                    {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : <ChevronRight />}
                    {query.isFetchingNextPage ? "Loading…" : "Load older Events"}
                  </Button>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          {selectedEventId ? <EventInspector projectId={projectId} eventId={selectedEventId} onClose={closeEvent} /> : null}
        </div>
      </div>
    </main>
  );
}

function EventRow({ event, selected, onSelect }: { event: DomainEventListItem; selected: boolean; onSelect: () => void }) {
  const nodeSha = nodeShaForReference(event.reference);
  return (
    <li className="relative pb-3 pl-7 last:pb-0">
      <span className="absolute -left-[7px] top-5 flex size-3 rounded-full border-2 border-[color:var(--apple-canvas-alt)] bg-[color:var(--apple-blue)]" />
      <button
        type="button"
        className={cn("group flex w-full items-start gap-3 rounded-[14px] border bg-white/72 p-4 text-left transition hover:bg-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24", selected && "border-[color:var(--apple-blue)] bg-white")}
        onClick={onSelect}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]">{eventIcon(event.type)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-semibold">{eventLabel(event.type)}</span>
            <span className="font-mono text-[9px] text-muted-foreground">#{event.sequence}</span>
            {nodeSha ? <Badge variant="outline">{shortSha(nodeSha)}</Badge> : null}
          </span>
          <span className="mt-1 block text-[11px] leading-5 text-[color:var(--apple-body)]">{event.summary}</span>
          <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-muted-foreground">
            <span>{event.actor.label} · {formatTimestamp(event.occurredAt)}</span>
            <span className="min-w-0 truncate font-mono" title={event.id}>event {event.id}</span>
            {event.reference.kind === "run" ? <span className="min-w-0 truncate font-mono" title={event.reference.runId}>run {event.reference.runId}</span> : null}
          </span>
        </span>
        <ChevronRight className="mt-2 size-3.5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}

function EventInspector({ projectId, eventId, onClose }: { projectId: string; eventId: string; onClose: () => void }) {
  const mobile = useMediaQuery("(max-width: 767px)");
  const query = useQuery({
    queryKey: ["projects", projectId, "events", eventId],
    queryFn: ({ signal }) => fetchEvent(projectId, eventId, signal),
    staleTime: 60_000,
    retry: false
  });
  const content = query.isLoading ? <PageLoading label="Loading Event…" /> : !query.data ? (
    <PageError message={apiErrorMessage(query.error, "The Event is unavailable.")} onRetry={() => void query.refetch()} />
  ) : <EventDetail projectId={projectId} event={query.data.event} stateHeadSha={query.data.stateHeadSha} />;

  if (!mobile) {
    return (
      <aside aria-label="Event details" className="absolute inset-y-4 right-4 z-20 hidden w-[390px] overflow-hidden rounded-[18px] border bg-white/94 shadow-[var(--apple-node-shadow)] backdrop-blur-xl md:flex md:flex-col">
        <div className="flex h-12 items-center justify-between border-b px-4"><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Event details</p><Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Close Event details" onClick={onClose}><X /></Button></div>
        <ScrollArea className="min-h-0 flex-1"><div className="p-5">{content}</div></ScrollArea>
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
      <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto bg-[color:var(--apple-canvas-alt)]">
        <SheetHeader><SheetTitle>Event details</SheetTitle><SheetDescription>Immutable domain history at an exact state head.</SheetDescription></SheetHeader>
        <div className="mt-5">{content}</div>
      </SheetContent>
    </Sheet>
  );
}

function EventDetail({ projectId, event, stateHeadSha }: { projectId: string; event: DomainEventListItem; stateHeadSha: string }) {
  const nodeSha = nodeShaForReference(event.reference);
  return (
    <div>
      <div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]">{eventIcon(event.type)}</span><div><p className="text-sm font-semibold">{eventLabel(event.type)}</p><p className="mt-0.5 font-mono text-[9px] text-muted-foreground">sequence {event.sequence}</p></div></div>
      <p className="mt-5 text-[12px] leading-6 text-[color:var(--apple-body)]">{event.summary}</p>
      <dl className="mt-5 grid gap-3 border-t pt-5 text-[11px]">
        <Detail label="Actor" value={event.actor.label} />
        <Detail label="Occurred" value={formatTimestamp(event.occurredAt)} />
        <Detail label="Event ID" value={event.id} mono />
        {event.reference.kind === "run" ? <Detail label="Run ID" value={event.reference.runId} mono /> : null}
        <Detail label="State head" value={stateHeadSha} mono />
      </dl>
      {nodeSha ? <Button type="button" variant="outline" className="mt-6 w-full" onClick={() => pushAppPath(projectNodePath(projectId, nodeSha))}><Network />View in graph<ArrowRight /></Button> : null}
      <p className="mt-6 text-[10px] leading-5 text-muted-foreground">This projection has no edit, delete, or rollback controls. Changes require a new append-only command.</p>
    </div>
  );
}

function FilterField({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={cn("grid gap-1", className)}><span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</span>{children}</label>;
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt className="text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{label}</dt><dd className={cn("mt-1 break-all", mono && "font-mono text-[9px]")}>{value}</dd></div>;
}

function eventLabel(type: DomainEventType): string {
  return type.replace(/([a-z])([A-Z])/gu, "$1 $2");
}

function eventIcon(type: DomainEventType) {
  if (type.startsWith("Run")) return type === "RunStarted" ? <Play className="size-3.5" /> : <GitCommit className="size-3.5" />;
  if (type.startsWith("Coach") || type.startsWith("Coaching")) return <Bot className="size-3.5" />;
  if (type === "AlternativeSelected" || type === "AlternativesRejected" || type === "AlternativesCompared") return <CheckCircle2 className="size-3.5" />;
  return <Network className="size-3.5" />;
}

function nodeShaForReference(reference: EventReference): string | null {
  if (reference.kind === "node") return reference.nodeSha;
  if (reference.kind === "run") return reference.target.kind === "registered" ? reference.target.nodeSha : reference.sourceNodeSha;
  return null;
}

function uniqueEvents(events: readonly DomainEventListItem[]): readonly DomainEventListItem[] {
  const seen = new Set<string>();
  return events.filter(event => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

function isProgressEvent(type: DomainEventType): boolean {
  return type === "RunStarted" || type === "RunCheckpointed" || type === "RunEvidenceAttached";
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
