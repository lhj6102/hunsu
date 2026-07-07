import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Folder, GitBranch, Plus, Search } from "lucide-react";
import { pushStudioPath, studioRoadmapPath } from "@/app/routes";
import { cn } from "@/lib/utils";
import { postFilesystemGrant, postRoadmapCreate, postRoadmapOpen } from "@/shared/api/bridgeClient";
import { ROADMAP_REGISTRY_QUERY_KEY, upsertRoadmapRegistryCache, useFilesystemBrowser } from "@/shared/api/useStudioData";
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
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | undefined>();
  const [busyAction, setBusyAction] = useState<"open" | "create" | undefined>();

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
    setMessage("Opening Roadmap...");
    setBusyAction("open");
    try {
      const capability = await grantPath(entry.path, entry.rootId);
      if (!entry.isRoadmap) {
        pushStudioPath(`/studio/port?path=${encodeURIComponent(entry.path)}&browseToken=${encodeURIComponent(capability.browseToken)}&rootId=${encodeURIComponent(capability.rootId)}`);
        return;
      }
      const result = await postRoadmapOpen({ browseToken: capability.browseToken, path: entry.path });
      refreshRoadmapRegistry(result.roadmap);
      pushStudioPath(studioRoadmapPath(result.roadmap.roadmapId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to open Roadmap.");
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

  return (
    <main className="apple-page h-screen overflow-hidden">
      <section className="mx-auto flex h-full w-full max-w-[1180px] flex-col px-6 py-8 lg:px-10 lg:py-12">
        <div className="shrink-0">
          <p className="text-[13px] font-medium leading-5 text-muted-foreground">{modeLabel(mode)}</p>
          <h1 className="mt-1 font-[family-name:var(--apple-font-display)] text-[44px] font-semibold leading-[1.08] tracking-normal text-[color:var(--apple-ink)]">
            Project Finder
          </h1>
        </div>

        <div className="apple-glass-strong mt-8 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] p-4">
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
          {message ? <p className="mt-3 shrink-0 text-[13px] leading-5 text-muted-foreground">{message}</p> : null}

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
      </section>
    </main>
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
        {entry.isRoadmap ? <Badge variant="success">Roadmap</Badge> : entry.isGitRepository ? <Badge variant="outline">Git</Badge> : null}
        <Button type="button" size="sm" variant={entry.isRoadmap ? "default" : "outline"} disabled={busy} onClick={() => onOpen(entry)}>
          {entry.isRoadmap ? "Open" : "Inspect"}
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
  return value.startsWith("/");
}

function modeLabel(mode: "launcher" | "open" | "port"): string {
  if (mode === "port") return "Inspect or create from a Git project";
  if (mode === "open") return "Open an existing Roadmap";
  return "Open or create from a project";
}
