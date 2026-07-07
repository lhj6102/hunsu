import { GitCommit, Loader2, Route } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { formatShortRef, type RoadmapViewModel } from "@/shared/domain/roadmapViewModel";

export function ExecuteOverlayPanel({ model }: { model: RoadmapViewModel }) {
  const run = model.activeRun;
  return (
    <section className="border-t">
      <div className="border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Execute Overlay</h2>
          <Badge variant={run?.status === "running" ? "secondary" : "outline"}>{run?.status ?? "idle"}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{run?.liveStatus?.headline ?? "No active Execute."}</p>
      </div>
      <ScrollArea className="max-h-64">
        <div className="space-y-2 p-4">
          {(run?.memberPathRuns ?? []).map(path => (
            <div key={path.pathId} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {path.status === "starting" || path.status === "executing" ? <Loader2 className="size-3.5 animate-spin text-[color:var(--studio-faker)]" /> : <Route className="size-3.5 text-muted-foreground" />}
                    <p className="truncate text-sm font-medium">{path.pathId}</p>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{path.goal}</p>
                </div>
                <Badge variant={path.status === "completed" ? "success" : path.status === "failed" ? "destructive" : "outline"}>{path.status}</Badge>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <GitCommit className="size-3.5" />
                {formatShortRef("commit" in path ? path.commit : undefined)}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
