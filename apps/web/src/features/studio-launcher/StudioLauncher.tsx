import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Folder, GitBranch, Plus, Search, Trash2 } from "lucide-react";
import { pushStudioPath, studioRoadmapPath } from "@/app/routes";
import { cn } from "@/lib/utils";
import { postFilesystemGrant, postRoadmapCreate, postRoadmapOpen, postRoadmapPortApply, postRoadmapRegistryRemove } from "@/shared/api/bridgeClient";
import { ROADMAP_REGISTRY_QUERY_KEY, upsertRoadmapRegistryCache, useFilesystemBrowser, useRoadmapRegistry } from "@/shared/api/useStudioData";
import type { BrowseRootId, FilesystemBrowseEntry, RoadmapRegistryEntry } from "@/shared/api/bridgeTypes";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Skeleton } from "@/shared/ui/skeleton";

type FinderItem =
  | { kind: "create"; id: string; title: string; subtitle: string; path: string; disabled: boolean }
  | { kind: "folder"; id: string; entry: FilesystemBrowseEntry };

export function StudioLauncher({
  mode = "launcher",
  initialPath,
  initialRootId
}: {
  mode?: "launcher" | "open" | "port";
  initialPath?: string;
  initialBrowseToken?: string;
  initialRootId?: string;
}) {
  const [path, setPath] = useState(initialPath ?? "");
  const [rootId, setRootId] = useState<string | undefined>(initialRootId);
  const requestedPath = path.trim();
  const canUsePath = isAbsoluteLocalPath(requestedPath);
  const browser = useFilesystemBrowser(canUsePath ? requestedPath : undefined, rootId);
  const registry = useRoadmapRegistry();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | undefined>();
  const [busyAction, setBusyAction] = useState<"open" | "create" | "repair" | "remove" | undefined>();
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialPath));

  const finderItems = useMemo<FinderItem[]>(() => {
    const items: FinderItem[] = [
      {
        kind: "create",
        id: "create-roadmap",
        title: "Create Roadmap",
        subtitle: canUsePath ? requestedPath : "Enter an absolute path first",
        path: requestedPath,
        disabled: !canUsePath
      }
    ];
    items.push(
      ...browser.data.entries
        .filter(entry => entry.type === "directory")
        .slice(0, 80)
        .map(entry => ({ kind: "folder" as const, id: `folder:${entry.path}`, entry }))
    );
    return items;
  }, [browser.data.entries, canUsePath, requestedPath]);

  async function openRoadmap(entry: FilesystemBrowseEntry) {
    setMessage(entry.isRoadmap ? "Opening Roadmap..." : entry.isGitRepository ? "Porting Git project..." : "Creating Roadmap...");
    setBusyAction("open");
    try {
      const capability = await grantPath(entry.path, entry.rootId);
      const result = entry.isRoadmap
        ? await postRoadmapOpen({ browseToken: capability.browseToken, path: entry.path })
        : entry.isGitRepository
          ? await postRoadmapPortApply({
              browseToken: capability.browseToken,
              path: entry.path,
              title: entry.name,
              goal: `Port ${entry.name} into Hunsu.`
            })
          : await postRoadmapCreate({ browseToken: capability.browseToken, path: entry.path });
      refreshRoadmapRegistry(result.roadmap);
      pushStudioPath(studioRoadmapPath(result.roadmap.roadmapId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to complete project action.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function createRoadmap(targetPath = requestedPath) {
    if (!isAbsoluteLocalPath(targetPath)) {
      setMessage("Enter an absolute folder path before creating a Roadmap.");
      return;
    }
    setMessage("Creating Roadmap...");
    setBusyAction("create");
    try {
      const capability = await grantPath(targetPath, browser.data.rootId ?? (rootId as BrowseRootId | undefined));
      const result = await postRoadmapCreate({ browseToken: capability.browseToken, path: targetPath });
      refreshRoadmapRegistry(result.roadmap);
      pushStudioPath(studioRoadmapPath(result.roadmap.roadmapId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create Roadmap.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function grantPath(targetPath: string, targetRootId?: BrowseRootId | string) {
    const result = await postFilesystemGrant(targetRootId, targetPath);
    return result.capability;
  }

  function refreshRoadmapRegistry(roadmap: RoadmapRegistryEntry) {
    queryClient.setQueryData<RoadmapRegistryEntry[]>(ROADMAP_REGISTRY_QUERY_KEY, current => upsertRoadmapRegistryCache(current, roadmap));
    void queryClient.invalidateQueries({ queryKey: ROADMAP_REGISTRY_QUERY_KEY });
  }

  async function removeRecentRoadmap(roadmap: RoadmapRegistryEntry) {
    setBusyAction("remove");
    setMessage("Removing recent Roadmap...");
    try {
      const roadmaps = await postRoadmapRegistryRemove({ roadmapId: roadmap.roadmapId });
      queryClient.setQueryData<RoadmapRegistryEntry[]>(ROADMAP_REGISTRY_QUERY_KEY, roadmaps);
      setMessage("Removed from recent Roadmaps.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to remove recent Roadmap.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function repairRecentRoadmap(roadmap: RoadmapRegistryEntry) {
    setBusyAction("repair");
    setMessage("Repairing Roadmap...");
    try {
      const capability = await grantPath(roadmap.repositoryPath);
      const result = await postRoadmapCreate({
        browseToken: capability.browseToken,
        path: roadmap.repositoryPath,
        title: roadmap.displayName
      });
      refreshRoadmapRegistry(result.roadmap);
      pushStudioPath(studioRoadmapPath(result.roadmap.roadmapId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to repair Roadmap.");
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <main className="apple-page h-screen overflow-hidden">
      <section className="mx-auto flex h-full w-full max-w-[1180px] flex-col px-6 py-8 lg:px-10 lg:py-12">
        <div className="shrink-0">
          <p className="text-[13px] font-medium leading-5 text-muted-foreground">{modeLabel(mode)}</p>
          <h1 className="mt-1 font-[family-name:var(--apple-font-display)] text-[44px] font-semibold leading-[1.08] tracking-normal text-[color:var(--apple-ink)]">
            Project Finder
          </h1>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button type="button" size="lg" onClick={() => openBridgeLink("hunsu://open-project")}>
              <ExternalLink className="size-4" />
              Choose Folder in Bridge App
            </Button>
            <Button type="button" size="lg" variant="outline" onClick={() => openBridgeLink("hunsu://pair?next=/studio")}>
              <ExternalLink className="size-4" />
              Open Hunsu Bridge
            </Button>
          </div>
        </div>

        {registry.data.length > 0 ? (
          <section className="mt-6 shrink-0 rounded-[18px] border border-[color:var(--apple-hairline)] bg-white/58 px-4 py-3">
            <div className="grid gap-2">
              {registry.data.slice(0, 5).map(roadmap => (
                <RecentRoadmapRow
                  key={roadmap.roadmapId}
                  roadmap={roadmap}
                  busy={busyAction !== undefined}
                  onRepair={repairRecentRoadmap}
                  onRemove={removeRecentRoadmap}
                />
              ))}
            </div>
          </section>
        ) : null}

        {message ? <p className="mt-4 shrink-0 text-[13px] leading-5 text-muted-foreground">{message}</p> : null}

        <details
          className="mt-6 shrink-0 rounded-[18px] border border-[color:var(--apple-hairline)] bg-white/46 px-4 py-3"
          open={advancedOpen}
          onToggle={event => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-[13px] font-semibold text-[color:var(--apple-ink)]">Advanced</summary>
          <div className="mt-4 flex max-h-[min(520px,calc(100vh-300px))] min-h-[280px] flex-col overflow-hidden rounded-[16px] border border-[color:var(--apple-hairline)] bg-white/42 p-4">
            <div className="flex shrink-0 flex-col gap-3 md:flex-row md:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Repository path"
                  className="pl-11"
                  value={path}
                  onChange={event => {
                    setPath(event.target.value);
                    setRootId(undefined);
                  }}
                  placeholder="/path/to/project"
                />
              </div>
            </div>

            <ScrollArea className="mt-4 min-h-0 flex-1">
              <div className="grid divide-y divide-[color:var(--border)]">
                {browser.status === "connecting" ? <FinderSkeleton /> : null}
                {finderItems.map(item => (
                  <FinderRow
                    key={item.id}
                    item={item}
                    busy={busyAction !== undefined}
                    onChoosePath={(nextPath, nextRootId) => {
                      setPath(nextPath);
                      setRootId(nextRootId);
                    }}
                    onCreate={createRoadmap}
                    onOpen={openRoadmap}
                  />
                ))}
                {browser.status !== "connecting" && finderItems.length === 1 ? (
                  <div className="px-3 py-5 text-[13px] leading-5 text-muted-foreground">
                    No folders found for this path.
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </details>
      </section>
    </main>
  );
}

function RecentRoadmapRow({
  roadmap,
  busy,
  onRepair,
  onRemove
}: {
  roadmap: RoadmapRegistryEntry;
  busy: boolean;
  onRepair: (roadmap: RoadmapRegistryEntry) => void;
  onRemove: (roadmap: RoadmapRegistryEntry) => void;
}) {
  const primaryAction = roadmap.primaryAction ?? (roadmap.health === "ok" ? "open" : "remove");
  const canOpen = primaryAction === "open";
  const canRepair = primaryAction === "repair";
  const unhealthy = !canOpen;
  return (
    <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2 py-2 hover:bg-white/46">
      <button
        type="button"
        className="flex min-w-0 items-center gap-3 text-left"
        onClick={() => canOpen ? pushStudioPath(studioRoadmapPath(roadmap.roadmapId)) : undefined}
      >
        <span className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          unhealthy ? "bg-[color:var(--apple-orange)]/12 text-[color:var(--apple-orange)]" : "bg-white text-[color:var(--apple-green)]"
        )}>
          {unhealthy ? <AlertTriangle className="size-4" /> : <Folder className="size-4" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-[color:var(--apple-ink)]">{roadmap.displayName}</span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">{roadmap.health} · {roadmap.repositoryPath}</span>
        </span>
      </button>
      {canOpen ? (
        <Button type="button" size="sm" disabled={busy} onClick={() => pushStudioPath(studioRoadmapPath(roadmap.roadmapId))}>
          Open
        </Button>
      ) : canRepair ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRepair(roadmap)}>
          Repair
        </Button>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRemove(roadmap)}>
          <Trash2 className="size-4" />
          Remove
        </Button>
      )}
    </div>
  );
}

function FinderRow({
  item,
  busy,
  onChoosePath,
  onCreate,
  onOpen
}: {
  item: FinderItem;
  busy: boolean;
  onChoosePath: (path: string, rootId?: BrowseRootId) => void;
  onCreate: (path?: string) => void;
  onOpen: (entry: FilesystemBrowseEntry) => void;
}) {
  if (item.kind === "create") {
    return (
      <button
        type="button"
        className={finderRowClassName(item.disabled)}
        disabled={busy || item.disabled}
        onClick={() => onCreate(item.path)}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue)] text-white">
          <Plus className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{item.title}</span>
          <span className="block truncate text-[12px] leading-5 text-muted-foreground">{item.subtitle}</span>
        </span>
        <Badge variant="default">New</Badge>
      </button>
    );
  }

  const entry = item.entry;
  return (
    <div className={cn(finderRowClassName(false), "cursor-default")}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onChoosePath(entry.path, entry.rootId)}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-[color:var(--apple-muted)]">
          {entry.isGitRepository ? <GitBranch className="size-4" /> : <Folder className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{entry.name}</span>
          <span className="block truncate text-[12px] leading-5 text-muted-foreground">{entry.path}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2">
        {entry.isRoadmap ? <Badge variant="success">Roadmap</Badge> : entry.isGitRepository ? <Badge variant="outline">Git</Badge> : <Badge variant="muted">New</Badge>}
        <Button type="button" size="sm" variant={entry.isRoadmap ? "default" : "outline"} disabled={busy} onClick={() => onOpen(entry)}>
          {entry.isRoadmap ? "Open" : entry.isGitRepository ? "Port" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function finderRowClassName(disabled: boolean): string {
  return cn(
    "flex min-h-[68px] w-full min-w-0 items-center gap-3 px-3 py-3 text-left text-[color:var(--apple-ink)] transition-[background,color] hover:bg-white/46 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24",
    disabled && "opacity-50"
  );
}

function FinderSkeleton() {
  return (
    <div className="grid">
      <Skeleton className="h-[68px] rounded-none bg-white/42" />
      <Skeleton className="h-[68px] rounded-none bg-white/42" />
    </div>
  );
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

function openBridgeLink(url: string): void {
  window.location.href = url;
}

function modeLabel(mode: "launcher" | "open" | "port"): string {
  if (mode === "port") return "Inspect or create from a Git project";
  if (mode === "open") return "Open an existing Roadmap";
  return "Open or create from a project";
}
